/**
 * Web entry request pipeline — HTTP/1.1 only, no node:* dependencies.
 * Simplified from src/client.ts: no H2, no connection pool, no protocol cache.
 */
import { parseUrl, type ParsedUrl } from "../utils/url.js";
import { normalizeHeaders, type HeadersInit } from "../utils/headers.js";
import { createRawSocket, type RawSocket } from "./raw-socket.js";
import { connectWasmTls, preloadWasmTls, type WasmTlsSocket } from "./wasm-tls.js";
import { http1Request } from "./http1/client.js";
import {
  isCloudflareNetworkError,
  resolveIPv4,
  resolveAndCheckCloudflare,
  NAT64_PREFIXES,
  ipv4ToNAT64,
  type CfCheckResult,
} from "../socket/nat64.js";
import { rankNat64Prefixes, recordNat64PrefixResult } from "../socket/nat64-health.js";
import { concatBytes, encode } from "./bytes.js";
import { getCachedDns, setCachedDns } from "../dns-cache.js";

export interface RetryOptions {
  limit?: number;
  methods?: string[];
  statusCodes?: number[];
  maxDelay?: number;
  baseDelay?: number;
}

export interface RequestOptions {
  method?: string;
  headers?: HeadersInit;
  body?: Uint8Array | string | ReadableStream<Uint8Array> | null;
  timeout?: number;
  headersTimeout?: number;
  bodyTimeout?: number;
  signal?: AbortSignal;
  redirect?: "follow" | "manual";
  maxRedirects?: number;
  retry?: number | RetryOptions | false;
  decompress?: boolean;
  compressBody?: boolean;
}

interface NormalizedOptions {
  method?: string;
  headers: Record<string, string>;
  timeout?: number;
  headersTimeout?: number;
  bodyTimeout?: number;
  decompress?: boolean;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawHeaders: ReadonlyArray<[string, string]>;
  protocol: "http/1.1";
  body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  getSetCookie(): string[];
}

export interface PrewarmDnsOptions {
  concurrency?: number;
  signal?: AbortSignal;
  ignoreErrors?: boolean;
}

// ── DNS cache dedup ──

const dnsInflight = new Map<string, Promise<CfCheckResult>>();

async function resolveAndCheckCloudflareCached(hostname: string): Promise<CfCheckResult> {
  const key = hostname.toLowerCase();
  const cached = getCachedDns(key);
  if (cached) return cached;

  const inflight = dnsInflight.get(key);
  if (inflight) return inflight;

  const lookupPromise = (async () => {
    try {
      const result = await resolveAndCheckCloudflare(key);
      setCachedDns(key, result);
      return result;
    } catch (err) {
      console.debug(`[dns] DoH failed for ${key}, degrading to direct:`, err);
      const degraded: CfCheckResult = { isCf: false, ipv4: null, dnsMs: 0, ttl: 0 };
      setCachedDns(key, degraded);
      return degraded;
    } finally {
      dnsInflight.delete(key);
    }
  })();

  dnsInflight.set(key, lookupPromise);
  return lookupPromise;
}

// ── NAT64 constants ──

const NAT64_PREFIX_COUNT = 3;
const NAT64_PER_PREFIX_TIMEOUT = 1000;
const NAT64_HEDGE_DELAY_MS = 200;

/** @internal */
export interface Nat64Candidate {
  prefix: string;
  connectHostname: string;
}

function getNat64Candidates(ipv4: string): Nat64Candidate[] {
  const preferred = NAT64_PREFIXES.slice(0, NAT64_PREFIX_COUNT);
  const ranked = rankNat64Prefixes(preferred);
  return ranked.map(prefix => ({
    prefix,
    connectHostname: ipv4ToNAT64(ipv4, prefix),
  }));
}

async function resolveNat64IPv4(
  hostname: string,
  existingIPv4?: string | null,
): Promise<string | null> {
  if (existingIPv4) return existingIPv4;
  try {
    const dns = await resolveIPv4(hostname);
    return dns?.ipv4 ?? null;
  } catch {
    return null;
  }
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"]);

function isMethodIdempotent(method: string | undefined): boolean {
  return IDEMPOTENT_METHODS.has((method ?? "GET").toUpperCase());
}

// ── Public API ──

export async function prewarmDns(
  hostnames: readonly string[],
  options: PrewarmDnsOptions = {},
): Promise<void> {
  const unique = [...new Set(hostnames.map(h => h.trim().toLowerCase()).filter(Boolean))];
  if (unique.length === 0) return;

  const signal = options.signal;
  const concurrency = Math.min(16, Math.max(1, options.concurrency ?? 4));
  const ignoreErrors = options.ignoreErrors ?? true;
  let cursor = 0;

  const worker = async () => {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const index = cursor++;
      if (index >= unique.length) return;
      try {
        await resolveAndCheckCloudflareCached(unique[index]);
      } catch (error) {
        if (!ignoreErrors) throw error;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
}

export async function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  if (options.body instanceof ReadableStream && options.body.locked) {
    throw new TypeError("ReadableStream body is already locked");
  }

  const timeout = options.timeout ?? 30000;
  const timeoutController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  if (timeout > 0 && timeout < Infinity) {
    timer = setTimeout(() => {
      timeoutController.abort(new DOMException("Request timeout", "TimeoutError"));
    }, timeout);
  }

  const internalSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const retryConfig = normalizeRetry(options.retry);
    if (!retryConfig || retryConfig.limit === 0) {
      return await doRequest(url, options, internalSignal);
    }

    const method = (options.method ?? "GET").toUpperCase();
    const isStreamBody = options.body instanceof ReadableStream;
    const canRetry = retryConfig.methods.has(method) && !isStreamBody;

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await doRequest(url, options, internalSignal);
        if (
          canRetry &&
          attempt < retryConfig.limit &&
          retryConfig.statusCodes.has(response.status)
        ) {
          await consumeAndDiscard(response);
          const delay = calculateRetryDelay(response.headers["retry-after"], attempt, retryConfig);
          await sleep(delay, internalSignal);
          continue;
        }
        return response;
      } catch (err) {
        if (canRetry && attempt < retryConfig.limit && !internalSignal.aborted) {
          const delay = Math.min(retryConfig.baseDelay * 2 ** attempt, retryConfig.maxDelay);
          await sleep(delay, internalSignal);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (timeoutController.signal.aborted) {
      throw new DOMException(`Request timed out after ${timeout}ms`, "TimeoutError");
    }
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Request pipeline ──

async function doRequest(
  url: string,
  options: RequestOptions,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const redirect = options.redirect ?? "follow";
  const maxRedirects = options.maxRedirects ?? 5;

  let currentUrl = url;
  let currentMethod = options.method ?? "GET";
  const currentHeaders = normalizeHeaders(options.headers);
  let currentBody = options.body;
  let redirectCount = 0;
  const visitedUrls = new Set<string>();

  if (typeof currentBody === "string" && !hasHeader(currentHeaders, "content-type")) {
    currentHeaders["content-type"] = "text/plain;charset=UTF-8";
  }

  if (options.decompress !== false && !hasHeader(currentHeaders, "accept-encoding")) {
    currentHeaders["accept-encoding"] = "gzip, deflate";
  }

  while (true) {
    throwIfAborted(signal);

    const parsed = parseUrl(currentUrl);
    let body = normalizeBody(currentBody);

    // Compress request body
    if (
      options.compressBody &&
      body instanceof Uint8Array &&
      body.byteLength > 1024 &&
      !hasHeader(currentHeaders, "content-encoding")
    ) {
      const compressed = await compressRequestBody(body);
      currentHeaders["content-encoding"] = "gzip";
      currentHeaders["content-length"] = String(compressed.byteLength);
      body = compressed;
    }

    const reqOptions: NormalizedOptions = {
      method: currentMethod,
      headers: currentHeaders,
      timeout: options.timeout,
      headersTimeout: options.headersTimeout,
      bodyTimeout: options.bodyTimeout,
      decompress: options.decompress,
    };

    const response = await doRequestInner(parsed, reqOptions, body, signal);

    // Not a redirect or manual mode
    if (redirect !== "follow" || response.status < 300 || response.status >= 400) {
      return response;
    }

    // 3xx redirect handling
    redirectCount++;
    if (redirectCount > maxRedirects) {
      throw new Error(`Maximum redirects (${maxRedirects}) exceeded`);
    }

    const location = response.headers["location"];
    if (!location) return response;

    await consumeAndDiscard(response);

    const resolvedUrl = resolveRedirectUrl(currentUrl, location);
    const newParsed = parseUrl(resolvedUrl);

    if (parsed.protocol === "https" && newParsed.protocol === "http") {
      throw new Error(`Refused to follow redirect from HTTPS to HTTP: ${resolvedUrl}`);
    }

    if (visitedUrls.has(resolvedUrl)) {
      throw new Error(`Redirect loop detected: ${resolvedUrl}`);
    }
    visitedUrls.add(resolvedUrl);

    if (response.status === 301 || response.status === 302 || response.status === 303) {
      currentMethod = "GET";
      currentBody = null;
      delete currentHeaders["content-type"];
      delete currentHeaders["content-length"];
      delete currentHeaders["content-encoding"];
    } else if (currentBody instanceof ReadableStream) {
      throw new Error(
        "Cannot follow redirect with a ReadableStream body (stream is not replayable)",
      );
    }

    if (isOriginChange(parsed, newParsed)) {
      delete currentHeaders["authorization"];
      delete currentHeaders["cookie"];
      delete currentHeaders["proxy-authorization"];
    }

    currentHeaders["host"] = newParsed.hostname;
    currentUrl = resolvedUrl;
  }
}

async function doRequestInner(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const tls = parsed.protocol === "https";
  const isStreamBody = body instanceof ReadableStream;
  const idempotent = isMethodIdempotent(options.method);

  if (tls) {
    throwIfAborted(signal);
    const cfCheck = await resolveAndCheckCloudflareCached(parsed.hostname);
    console.debug(
      `[web:request] ${parsed.hostname} isCf=${cfCheck.isCf} ipv4=${cfCheck.ipv4} dnsMs=${cfCheck.dnsMs}`,
    );

    if (cfCheck.isCf && cfCheck.ipv4) {
      // CF CDN → NAT64 + WASM TLS
      preloadWasmTls();
      const candidates = getNat64Candidates(cfCheck.ipv4);
      return await tryWithNat64(
        candidates,
        parsed,
        signal,
        isStreamBody,
        idempotent,
        (candidate, s) => h1RequestWithWasmTLS(parsed, options, body, s, candidate.connectHostname),
      );
    }

    // Non-CF → platform TLS direct
    try {
      return await h1RequestDirect(parsed, options, body, true, signal);
    } catch (err) {
      if (!isCloudflareNetworkError(err)) throw err;
      if (isStreamBody) throw err;
    }

    // Direct blocked → NAT64 fallback
    throwIfAborted(signal);
    preloadWasmTls();
    const ipv4 = await resolveNat64IPv4(parsed.hostname, cfCheck.ipv4);
    if (!ipv4) {
      throw new Error(
        `Connection blocked and DNS resolution failed for ${parsed.hostname}:${parsed.port}`,
      );
    }
    const candidates = getNat64Candidates(ipv4);
    return await tryWithNat64(
      candidates,
      parsed,
      signal,
      isStreamBody,
      idempotent,
      (candidate, s) => h1RequestWithWasmTLS(parsed, options, body, s, candidate.connectHostname),
      () =>
        `Connection blocked and all NAT64 prefixes failed for ${parsed.hostname}:${parsed.port}`,
    );
  }

  // HTTP (no TLS) → direct
  return h1RequestDirect(parsed, options, body, false, signal);
}

// ── Transport helpers ──

async function h1RequestDirect(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  tls: boolean,
  signal: AbortSignal,
): Promise<HttpResponse> {
  throwIfAborted(signal);
  const socket = await abortableConnect(
    () => createRawSocket({ hostname: parsed.hostname, port: parsed.port, tls }, signal),
    signal,
    s => s.close(),
  );

  try {
    const response = await http1Request(socket, {
      method: options.method ?? "GET",
      path: parsed.path,
      hostname: parsed.hostname,
      headers: options.headers ?? {},
      body,
      signal,
      headersTimeout: options.headersTimeout,
      bodyTimeout: options.bodyTimeout,
    });

    return wrapResponse(
      response.status,
      response.statusText,
      response.headers,
      response.rawHeaders,
      response.body,
      socket,
      options.decompress,
    );
  } catch (err) {
    socket.close();
    throw err;
  }
}

async function h1RequestWithWasmTLS(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  connectHostname: string,
): Promise<HttpResponse> {
  throwIfAborted(signal);
  const wasmSocket = await abortableConnect(
    () => connectWasmTls(parsed.hostname, parsed.port, ["http/1.1"], connectHostname, signal),
    signal,
    s => s.close(),
  );

  try {
    const response = await http1Request(wasmSocket, {
      method: options.method ?? "GET",
      path: parsed.path,
      hostname: parsed.hostname,
      headers: options.headers ?? {},
      body,
      signal,
      headersTimeout: options.headersTimeout,
      bodyTimeout: options.bodyTimeout,
    });

    return wrapResponse(
      response.status,
      response.statusText,
      response.headers,
      response.rawHeaders,
      response.body,
      wasmSocket,
      options.decompress,
    );
  } catch (err) {
    wasmSocket.close();
    throw err;
  }
}

// ── NAT64 hedging ──

type AttemptResult =
  | { ok: true; response: HttpResponse }
  | { ok: false; error: unknown; message: string; cancelled?: boolean };

/** @internal */
export async function tryWithNat64(
  candidates: Nat64Candidate[],
  parsed: ParsedUrl,
  signal: AbortSignal,
  isStreamBody: boolean,
  isIdempotent: boolean,
  attemptFn: (candidate: Nat64Candidate, signal: AbortSignal) => Promise<HttpResponse>,
  createFailureMessage?: (lastError: string) => string,
): Promise<HttpResponse> {
  if (candidates.length === 0) {
    throw new Error(`No NAT64 candidates available for ${parsed.hostname}:${parsed.port}`);
  }

  const startAttempt = (candidate: Nat64Candidate, index: number) => {
    const cancelController = new AbortController();
    const perPrefixSignal = AbortSignal.any([
      signal,
      cancelController.signal,
      AbortSignal.timeout(NAT64_PER_PREFIX_TIMEOUT),
    ]);
    const t0 = Date.now();
    const promise = (async (): Promise<AttemptResult> => {
      try {
        console.debug(
          `[web:request] ${parsed.hostname} trying NAT64[${index}] (${candidate.prefix}): ${candidate.connectHostname}`,
        );
        const response = await attemptFn(candidate, perPrefixSignal);
        const ms = Date.now() - t0;
        recordNat64PrefixResult(candidate.prefix, true, ms);
        console.debug(`[web:request] ${parsed.hostname} NAT64[${index}] OK in ${ms}ms`);
        return { ok: true, response };
      } catch (error) {
        const ms = Date.now() - t0;
        const message = error instanceof Error ? error.message : String(error);
        if (cancelController.signal.aborted && !signal.aborted) {
          return { ok: false, error, message: "cancelled-by-hedge", cancelled: true };
        }
        recordNat64PrefixResult(candidate.prefix, false, ms);
        console.debug(
          `[web:request] ${parsed.hostname} NAT64[${index}] failed in ${ms}ms: ${message}`,
        );
        return { ok: false, error, message };
      }
    })();

    return {
      promise,
      cancel: () =>
        cancelController.abort(
          new DOMException("NAT64 attempt cancelled by hedge winner", "AbortError"),
        ),
    };
  };

  const makeFailure = (lastError: string): Error =>
    createFailureMessage
      ? new Error(createFailureMessage(lastError))
      : new Error(
          `All ${candidates.length} NAT64 prefixes failed for ${parsed.hostname}:${parsed.port}. Last error: ${lastError}`,
        );

  let lastErrorMessage = "unknown error";

  // Stream bodies are not replayable — single attempt only.
  if (isStreamBody) {
    throwIfAborted(signal);
    const attempt = startAttempt(candidates[0], 0);
    const result = await attempt.promise;
    if (result.ok) return result.response;
    if (signal.aborted) throw result.error;
    throw makeFailure(result.message);
  }

  // Non-idempotent with non-stream body: serial retry across candidates.
  // NAT64 failures are connection-level (TCP/TLS handshake) — the request
  // body was never sent, so retrying with the next prefix is safe.
  // No hedging (parallel) to avoid duplicate delivery if the first
  // attempt's request actually reaches the server.
  if (!isIdempotent) {
    for (let i = 0; i < candidates.length; i++) {
      throwIfAborted(signal);
      const attempt = startAttempt(candidates[i], i);
      const result = await attempt.promise;
      if (result.ok) return result.response;
      if (signal.aborted) throw result.error;
      lastErrorMessage = result.message;
    }
    throw makeFailure(lastErrorMessage);
  }

  // Single candidate
  if (candidates.length === 1) {
    throwIfAborted(signal);
    const attempt = startAttempt(candidates[0], 0);
    const result = await attempt.promise;
    if (result.ok) return result.response;
    if (signal.aborted) throw result.error;
    throw makeFailure(result.message);
  }

  // Hedged first wave
  const first = startAttempt(candidates[0], 0);
  let second: ReturnType<typeof startAttempt> | null = null;

  try {
    const firstOrDelay = await Promise.race([
      first.promise.then(result => ({ kind: "first-result" as const, result })),
      sleep(NAT64_HEDGE_DELAY_MS, signal).then(() => ({ kind: "delay" as const })),
    ]);

    if (firstOrDelay.kind === "first-result") {
      if (firstOrDelay.result.ok) return firstOrDelay.result.response;
      if (signal.aborted) throw firstOrDelay.result.error;
      lastErrorMessage = firstOrDelay.result.message;

      second = startAttempt(candidates[1], 1);
      const secondResult = await second.promise;
      if (secondResult.ok) return secondResult.response;
      if (signal.aborted) throw secondResult.error;
      lastErrorMessage = secondResult.message;
    } else {
      second = startAttempt(candidates[1], 1);

      const firstWinner = await Promise.race([
        first.promise.then(result => ({ which: "first" as const, result })),
        second.promise.then(result => ({ which: "second" as const, result })),
      ]);

      if (firstWinner.result.ok) {
        const loser = firstWinner.which === "first" ? second : first;
        loser.cancel();
        // Clean up loser's response body if it also completed successfully
        loser.promise
          .then(r => {
            if (r.ok) r.response.body.cancel().catch(() => {});
          })
          .catch(() => {});
        return firstWinner.result.response;
      }
      if (signal.aborted) throw firstWinner.result.error;
      lastErrorMessage = firstWinner.result.message;

      const remainingResult =
        firstWinner.which === "first" ? await second.promise : await first.promise;
      if (remainingResult.ok) return remainingResult.response;
      if (signal.aborted) throw remainingResult.error;
      lastErrorMessage = remainingResult.message;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    throw error;
  }

  // Remaining candidates: serial
  for (let i = 2; i < candidates.length; i++) {
    throwIfAborted(signal);
    const attempt = startAttempt(candidates[i], i);
    const result = await attempt.promise;
    if (result.ok) return result.response;
    if (signal.aborted) throw result.error;
    lastErrorMessage = result.message;
  }

  throw makeFailure(lastErrorMessage);
}

// ── Response wrapping ──

function wrapResponse(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  rawHeaders: Array<[string, string]>,
  body: ReadableStream<Uint8Array>,
  socket: RawSocket | WasmTlsSocket | null,
  decompress?: boolean,
): HttpResponse {
  const encoding = headers["content-encoding"]?.toLowerCase().trim();
  if (decompress !== false && (encoding === "gzip" || encoding === "deflate")) {
    body = body.pipeThrough(new DecompressionStream(encoding));
    delete headers["content-encoding"];
    delete headers["content-length"];
    rawHeaders = rawHeaders.filter(([n]) => n !== "content-encoding" && n !== "content-length");
  }

  const cleanup = () => {
    if (socket) {
      socket.close();
      socket = null;
    }
  };

  const wrappedBody = createAutoCleanupStream(body, cleanup);

  let bodyConsumed = false;

  const consumeBody = async (): Promise<Uint8Array> => {
    if (bodyConsumed) throw new Error("Body already consumed");
    bodyConsumed = true;

    const reader = wrappedBody.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    return concatBytes(chunks);
  };

  return {
    status,
    statusText,
    headers,
    rawHeaders,
    protocol: "http/1.1",
    body: wrappedBody,
    async text(): Promise<string> {
      const bytes = await consumeBody();
      return new TextDecoder().decode(bytes);
    },
    async json(): Promise<unknown> {
      const text = await this.text();
      return JSON.parse(text);
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const bytes = await consumeBody();
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    },
    getSetCookie(): string[] {
      return rawHeaders.filter(([name]) => name === "set-cookie").map(([, value]) => value);
    },
  };
}

function createAutoCleanupStream(
  source: ReadableStream<Uint8Array>,
  onCleanup: () => void | Promise<void>,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cleaned = false;

  const doCleanup = () => {
    if (cleaned) return;
    cleaned = true;
    const result = onCleanup();
    if (result instanceof Promise) result.catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    start() {
      reader = source.getReader();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader!.read();
        if (done) {
          controller.close();
          doCleanup();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
        doCleanup();
      }
    },
    cancel(reason) {
      doCleanup();
      return reader?.cancel(reason);
    },
  });
}

// ── Helpers ──

async function abortableConnect<T>(
  connectFn: () => Promise<T>,
  signal: AbortSignal,
  cleanup: (v: T) => void,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (!settled) {
        settled = true;
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    connectFn().then(
      result => {
        signal.removeEventListener("abort", onAbort);
        if (settled) {
          cleanup(result);
          return;
        }
        settled = true;
        resolve(result);
      },
      err => {
        signal.removeEventListener("abort", onAbort);
        if (!settled) {
          settled = true;
          reject(err);
        }
      },
    );
  });
}

// normalizeHeaders is now imported from ../utils/headers.js
export { normalizeHeaders } from "../utils/headers.js";

function normalizeBody(
  body: Uint8Array | string | ReadableStream<Uint8Array> | null | undefined,
): Uint8Array | ReadableStream<Uint8Array> | null {
  if (!body) return null;
  if (typeof body === "string") return encode(body);
  return body;
}

async function compressRequestBody(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  await writer.write(data);
  await writer.close();

  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.byteLength;
  }
  return result;
}

function resolveRedirectUrl(baseUrl: string, location: string): string {
  if (location.startsWith("http://") || location.startsWith("https://")) {
    return location;
  }
  return new URL(location, baseUrl).href;
}

function isOriginChange(from: ParsedUrl, to: ParsedUrl): boolean {
  return from.hostname !== to.hostname || from.port !== to.port || from.protocol !== to.protocol;
}

async function consumeAndDiscard(response: HttpResponse): Promise<void> {
  await response.body.cancel();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

// ── Retry helpers ──

const DEFAULT_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const DEFAULT_RETRY_STATUS_CODES = new Set([408, 413, 429, 500, 502, 503, 504]);

interface NormalizedRetry {
  limit: number;
  methods: Set<string>;
  statusCodes: Set<number>;
  maxDelay: number;
  baseDelay: number;
}

export function normalizeRetry(
  retry: number | RetryOptions | false | undefined,
): NormalizedRetry | null {
  if (retry === false || retry === 0 || retry === undefined) return null;
  const opts = typeof retry === "number" ? { limit: retry } : retry;
  return {
    limit: opts.limit ?? 2,
    methods: opts.methods ? new Set(opts.methods.map(m => m.toUpperCase())) : DEFAULT_RETRY_METHODS,
    statusCodes: opts.statusCodes ? new Set(opts.statusCodes) : DEFAULT_RETRY_STATUS_CODES,
    maxDelay: opts.maxDelay ?? 30_000,
    baseDelay: opts.baseDelay ?? 1000,
  };
}

export function calculateRetryDelay(
  retryAfterHeader: string | undefined,
  attempt: number,
  config: { baseDelay: number; maxDelay: number },
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, config.maxDelay);
    }
    const date = Date.parse(retryAfterHeader);
    if (!isNaN(date)) {
      const ms = date - Date.now();
      if (ms > 0) return Math.min(ms, config.maxDelay);
    }
  }
  return Math.min(config.baseDelay * 2 ** attempt, config.maxDelay);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
