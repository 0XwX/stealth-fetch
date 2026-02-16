/**
 * Unified HTTP client with auto protocol negotiation.
 * Main entry point for the stealth-fetch library.
 *
 * Transparently falls back to NAT64 when direct connections are blocked
 * by Cloudflare Workers' outbound socket restrictions.
 */
import type { Duplex } from "node:stream";
import { parseUrl, type ParsedUrl } from "./utils/url.js";
import { normalizeHeaders, type HeadersInit } from "./utils/headers.js";
import { createSocket, createWasmTLSSocket } from "./socket/tls.js";
import { http1Request } from "./http1/client.js";
import { Http2Client } from "./http2/client.js";
import { Http2Connection } from "./http2/connection.js";
import {
  isCloudflareNetworkError,
  resolveIPv4,
  resolveAndCheckCloudflare,
  NAT64_PREFIXES,
  ipv4ToNAT64,
  type CfCheckResult,
} from "./socket/nat64.js";
import { rankNat64Prefixes, recordNat64PrefixResult } from "./socket/nat64-health.js";
import { getCachedDns, setCachedDns } from "./dns-cache.js";
import { preloadHpack } from "./http2/hpack.js";
import { preloadWasmTls } from "./socket/wasm-tls-bridge.js";
import { getCachedProtocol, setCachedProtocol } from "./protocol-cache.js";
import { getPooledClient, poolClient, removePooled } from "./connection-pool.js";

export interface RetryOptions {
  /** Max retry attempts (default: 2) */
  limit?: number;
  /** HTTP methods to retry (default: GET, HEAD, OPTIONS, PUT, DELETE) */
  methods?: string[];
  /** HTTP status codes to retry on (default: [408, 413, 429, 500, 502, 503, 504]) */
  statusCodes?: number[];
  /** Max retry delay in ms (default: 30000) */
  maxDelay?: number;
  /** Base delay for exponential backoff in ms — delay = baseDelay * 2^attempt (default: 1000) */
  baseDelay?: number;
}

export interface RequestOptions {
  method?: string;
  headers?: HeadersInit;
  body?: Uint8Array | string | ReadableStream<Uint8Array> | null;
  /** Protocol selection: 'h2', 'http/1.1', or 'auto' (default) */
  protocol?: "h2" | "http/1.1" | "auto";
  /** Request timeout in ms (default: 30000). Covers from call to response headers (includes retries/redirects). */
  timeout?: number;
  /** Timeout waiting for response headers in ms. */
  headersTimeout?: number;
  /** Timeout waiting for response body data in ms (idle). */
  bodyTimeout?: number;
  /** AbortSignal to cancel the request */
  signal?: AbortSignal;
  /** Redirect handling: 'follow' (default) or 'manual' */
  redirect?: "follow" | "manual";
  /** Maximum number of redirects to follow (default: 5) */
  maxRedirects?: number;
  /** Retry configuration. Set to 0 or false to disable. Default: 0 (no retry). */
  retry?: number | RetryOptions | false;
  /** Auto-decompress gzip/deflate response body. Default: true */
  decompress?: boolean;
  /** Compress request body with gzip (Uint8Array > 1KB only). Default: false */
  compressBody?: boolean;
  /**
   * Connection strategy: 'compat' (default) uses ALPN negotiation + protocol cache;
   *  'fast-h1' uses platform TLS for non-CF, WASM TLS h1-only for CF (faster, no h2).
   */
  strategy?: "compat" | "fast-h1";
}

/** Internal options after normalization (headers is always Record, body is separate) */
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
  /** Raw headers preserving original order and multi-values */
  rawHeaders: ReadonlyArray<[string, string]>;
  protocol: "h2" | "http/1.1";
  body: ReadableStream<Uint8Array>;

  /** Read body as text */
  text(): Promise<string>;
  /** Read body as JSON */
  json(): Promise<unknown>;
  /** Read body as ArrayBuffer */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Get all Set-Cookie header values as separate strings */
  getSetCookie(): string[];
}

/**
 * Pre-establish an HTTP/2 connection and place it in the pool.
 * Subsequent requests to the same origin will reuse this connection,
 * avoiding TCP + TLS + SETTINGS handshake latency (400-600ms).
 *
 * If the origin is behind CF CDN, automatically uses NAT64.
 * H1-only servers are connected and immediately closed (no pool benefit).
 */
export async function preconnect(hostname: string, port: number = 443): Promise<void> {
  // Already pooled → nothing to do
  const existing = getPooledClient(hostname, port);
  if (existing) return;

  preloadWasmTls();
  preloadHpack();

  // Check CF CDN status for NAT64
  const cfCheck = await resolveAndCheckCloudflareCached(hostname);

  if (cfCheck.isCf && cfCheck.ipv4) {
    const candidates = getNat64Candidates(cfCheck.ipv4);
    // Try NAT64 prefixes
    for (let i = 0; i < candidates.length; i++) {
      const t0 = Date.now();
      try {
        const perPrefixSignal = AbortSignal.timeout(NAT64_PER_PREFIX_TIMEOUT);
        const client = await abortableConnect(
          () =>
            Http2Client.connect(
              hostname,
              port,
              true,
              { settingsTimeout: 5000 },
              candidates[i].connectHostname,
              perPrefixSignal,
            ),
          perPrefixSignal,
          c => c.close().catch(() => {}),
        );
        recordNat64PrefixResult(candidates[i].prefix, true, Date.now() - t0);
        poolClient(hostname, port, client, candidates[i].connectHostname);
        return;
      } catch {
        recordNat64PrefixResult(candidates[i].prefix, false, Date.now() - t0);
        if (i === candidates.length - 1) {
          throw new Error(`preconnect: all NAT64 prefixes failed for ${hostname}:${port}`);
        }
      }
    }
    return;
  }

  // Non-CF target: direct connection
  try {
    const directSignal = AbortSignal.timeout(5000);
    const client = await abortableConnect(
      () =>
        Http2Client.connect(
          hostname,
          port,
          true,
          { settingsTimeout: 5000 },
          undefined,
          directSignal,
        ),
      directSignal,
      c => c.close().catch(() => {}),
    );
    poolClient(hostname, port, client);
  } catch {
    // H1-only or connection failed — nothing to pool
  }
}

export interface PrewarmDnsOptions {
  /**
   * Max parallel DNS warmups (default: 4, max: 16).
   *
   * Each hostname triggers 1 fetch subrequest (A record via DoH).
   * These count toward Workers' 6 simultaneous open connections limit
   * (shared with fetch, sockets, KV, Cache, R2, Queues).
   * Keep this low to leave headroom for the actual request's socket connections.
   */
  concurrency?: number;
  /** Optional cancellation signal */
  signal?: AbortSignal;
  /** Ignore per-host lookup errors (default: true) */
  ignoreErrors?: boolean;
}

/**
 * Warm DNS/CF-detection cache for a set of hostnames.
 * Useful for latency-sensitive cold starts.
 *
 * Each hostname costs 1 fetch subrequest (A record DNS-over-HTTPS query),
 * which shares Workers' 6 simultaneous connection limit with sockets and other APIs.
 * Results are cached (TTL 30s–5min), so repeated calls within the TTL are free.
 */
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
      const hostname = unique[index];
      try {
        await resolveAndCheckCloudflareCached(hostname);
      } catch (error) {
        if (!ignoreErrors) throw error;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
}

/**
 * Send an HTTP request over a raw socket, bypassing Cloudflare's cf-* headers.
 *
 * If the direct connection is blocked by CF Workers' outbound restrictions,
 * automatically falls back to NAT64 to reach the target.
 * @example
 * ```ts
 * const response = await request('https://api.openai.com/v1/chat/completions', {
 *   method: 'POST',
 *   headers: { 'Authorization': 'Bearer sk-...' },
 *   body: JSON.stringify({ model: 'gpt-4', messages: [...] })
 * });
 * const data = await response.json();
 * ```
 */
export async function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  // Check if already aborted
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  // Check if ReadableStream body is already locked
  if (options.body instanceof ReadableStream && options.body.locked) {
    throw new TypeError("ReadableStream body is already locked");
  }

  const timeout = options.timeout ?? 30000;

  // Create timeout AbortController
  const timeoutController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  if (timeout > 0 && timeout < Infinity) {
    timer = setTimeout(() => {
      timeoutController.abort(new DOMException("Request timeout", "TimeoutError"));
    }, timeout);
  }

  // Merge user signal + timeout signal
  const internalSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const retryConfig = normalizeRetry(options.retry);
    if (!retryConfig || retryConfig.limit === 0) {
      return await doRequest(url, options, internalSignal);
    }

    const method = (options.method ?? "GET").toUpperCase();
    // ReadableStream body can only be consumed once — disable retry
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

async function doRequest(
  url: string,
  options: RequestOptions,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const redirect = options.redirect ?? "follow";
  const maxRedirects = options.maxRedirects ?? 5;
  const protocol = options.protocol ?? "auto";
  const strategy = options.strategy ?? "compat";

  let currentUrl = url;
  let currentMethod = options.method ?? "GET";
  const currentHeaders = normalizeHeaders(options.headers);
  let currentBody = options.body;
  let redirectCount = 0;
  const visitedUrls = new Set<string>();

  // Auto-set Content-Type for string bodies (before normalizeBody converts to Uint8Array)
  if (typeof currentBody === "string" && !hasHeader(currentHeaders, "content-type")) {
    currentHeaders["content-type"] = "text/plain;charset=UTF-8";
  }

  // Auto-set Accept-Encoding for compressed responses (gzip/deflate only; CF Workers lacks brotli)
  if (options.decompress !== false && !hasHeader(currentHeaders, "accept-encoding")) {
    currentHeaders["accept-encoding"] = "gzip, deflate";
  }

  while (true) {
    throwIfAborted(signal);
    // Preload WASM TLS for any protocol that may need it (including fast-h1 fallback)
    if (protocol !== "http/1.1") preloadWasmTls();
    // Preload HPACK only when h2 is possible (compat strategy or explicit h2)
    if (protocol === "h2" || (protocol === "auto" && strategy !== "fast-h1")) preloadHpack();

    const parsed = parseUrl(currentUrl);
    let body = normalizeBody(currentBody);

    // Compress request body with gzip if requested (Uint8Array > 1KB, no existing content-encoding)
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

    let response: HttpResponse;
    if (protocol === "h2") {
      response = await h2Request(parsed, reqOptions, body, signal);
    } else if (protocol === "http/1.1") {
      response = await http11Request(parsed, reqOptions, body, signal);
    } else {
      response = await autoRequest(parsed, reqOptions, body, signal, strategy);
    }

    // Not a redirect or manual mode — return as-is
    if (redirect !== "follow" || response.status < 300 || response.status >= 400) {
      return response;
    }

    // 3xx redirect handling
    redirectCount++;
    if (redirectCount > maxRedirects) {
      throw new Error(`Maximum redirects (${maxRedirects}) exceeded`);
    }

    const location = response.headers["location"];
    if (!location) {
      return response;
    }

    // Consume and discard redirect response body (releases underlying resources)
    await consumeAndDiscard(response);

    // Resolve redirect URL (supports relative paths)
    const resolvedUrl = resolveRedirectUrl(currentUrl, location);
    const newParsed = parseUrl(resolvedUrl);

    // Block HTTPS → HTTP protocol downgrade (prevents MITM)
    if (parsed.protocol === "https" && newParsed.protocol === "http") {
      throw new Error(`Refused to follow redirect from HTTPS to HTTP: ${resolvedUrl}`);
    }

    // Detect redirect loops
    if (visitedUrls.has(resolvedUrl)) {
      throw new Error(`Redirect loop detected: ${resolvedUrl}`);
    }
    visitedUrls.add(resolvedUrl);

    // 301/302/303 → change to GET, drop body
    if (response.status === 301 || response.status === 302 || response.status === 303) {
      currentMethod = "GET";
      currentBody = null;
      delete currentHeaders["content-type"];
      delete currentHeaders["content-length"];
      delete currentHeaders["content-encoding"];
    } else if (currentBody instanceof ReadableStream) {
      // 307/308 preserves method+body, but ReadableStream cannot be replayed
      throw new Error(
        "Cannot follow redirect with a ReadableStream body (stream is not replayable)",
      );
    }

    // Cross-origin → remove sensitive headers
    if (isOriginChange(parsed, newParsed)) {
      delete currentHeaders["authorization"];
      delete currentHeaders["cookie"];
      delete currentHeaders["proxy-authorization"];
    }

    // Update host header
    currentHeaders["host"] = newParsed.hostname;
    currentUrl = resolvedUrl;
  }
}

/**
 * Cached wrapper around resolveAndCheckCloudflare().
 * Avoids repeated DoH queries for the same hostname (saves 2-5ms per hit).
 */
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
    } catch {
      // DoH failure (timeout, network error) → degrade to unknown, proceed with direct connection
      console.debug(`[dns] DoH failed for ${key}, degrading to direct`);
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

/** Number of NAT64 prefixes to try before giving up */
const NAT64_PREFIX_COUNT = 3;

/** Per-prefix timeout for NAT64 connection attempts (ms) */
const NAT64_PER_PREFIX_TIMEOUT = 1000;

/**
 * Launch 2nd NAT64 candidate after this delay when 1st is still pending.
 * Reduces long-tail latency without full fan-out.
 */
const NAT64_HEDGE_DELAY_MS = 200;

/** Timeout for WASM TLS ALPN handshake on first connection to non-CF targets (ms) */
const WASM_TLS_HANDSHAKE_TIMEOUT = 2000;

interface Nat64Candidate {
  prefix: string;
  connectHostname: string;
}

/**
 * Generate NAT64 connect hostnames for the given target (pure computation, no I/O).
 * cloudflare:sockets connect() is optimistic (returns before TCP handshake completes),
 * so TCP probing is unreliable. Instead, we generate candidates and try them with
 * actual TLS+HTTP requests.
 */
function getNat64Candidates(ipv4: string): Nat64Candidate[] {
  const preferred = NAT64_PREFIXES.slice(0, NAT64_PREFIX_COUNT);
  const ranked = rankNat64Prefixes(preferred);
  return ranked.map(prefix => ({
    prefix,
    connectHostname: ipv4ToNAT64(ipv4, prefix),
  }));
}

/**
 * Resolve IPv4 for NAT64, using existing value if available.
 */
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

async function autoRequest(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  strategy: "compat" | "fast-h1" = "compat",
): Promise<HttpResponse> {
  // For plain HTTP, always use HTTP/1.1
  if (parsed.protocol !== "https") {
    return http11Request(parsed, options, body, signal);
  }

  // Pre-detect CF CDN targets via DNS — skip doomed direct connections
  throwIfAborted(signal);
  const cfCheck = await resolveAndCheckCloudflareCached(parsed.hostname);
  console.debug(
    `[autoRequest] ${parsed.hostname} isCf=${cfCheck.isCf} ipv4=${cfCheck.ipv4} dnsMs=${cfCheck.dnsMs} strategy=${strategy}`,
  );

  if (strategy === "fast-h1") {
    return autoRequestFastH1(parsed, options, body, signal, cfCheck);
  }
  return autoRequestCompat(parsed, options, body, signal, cfCheck);
}

/** RFC 7231 idempotent methods — safe to hedge (send concurrently). */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"]);

function isMethodIdempotent(method: string | undefined): boolean {
  return IDEMPOTENT_METHODS.has((method ?? "GET").toUpperCase());
}

/**
 * Helper to attempt connection via multiple NAT64 candidates.
 * Uses hedged (parallel) retry for idempotent requests with non-stream bodies,
 * and strict serial retry otherwise.
 */
async function tryWithNat64(
  candidates: Nat64Candidate[],
  parsed: ParsedUrl,
  signal: AbortSignal,
  isStreamBody: boolean,
  isIdempotent: boolean,
  logPrefix: string,
  attemptFn: (candidate: Nat64Candidate, signal: AbortSignal) => Promise<HttpResponse>,
  createFailureMessage?: (lastError: string) => string,
): Promise<HttpResponse> {
  if (candidates.length === 0) {
    throw new Error(`No NAT64 candidates available for ${parsed.hostname}:${parsed.port}`);
  }

  type AttemptResult =
    | { ok: true; response: HttpResponse }
    | { ok: false; error: unknown; message: string; cancelled?: boolean };

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
          `[${logPrefix}] ${parsed.hostname} trying NAT64[${index}] (${candidate.prefix}): ${candidate.connectHostname}`,
        );
        const response = await attemptFn(candidate, perPrefixSignal);
        const ms = Date.now() - t0;
        recordNat64PrefixResult(candidate.prefix, true, ms);
        console.debug(`[${logPrefix}] ${parsed.hostname} NAT64[${index}] OK in ${ms}ms`);
        return { ok: true, response };
      } catch (error) {
        const ms = Date.now() - t0;
        const message = error instanceof Error ? error.message : String(error);
        if (cancelController.signal.aborted && !signal.aborted) {
          console.debug(
            `[${logPrefix}] ${parsed.hostname} NAT64[${index}] cancelled by hedge winner`,
          );
          return { ok: false, error, message: "cancelled-by-hedge", cancelled: true };
        }
        recordNat64PrefixResult(candidate.prefix, false, ms);
        console.debug(
          `[${logPrefix}] ${parsed.hostname} NAT64[${index}] failed in ${ms}ms: ${message}`,
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

  // Idempotent + non-stream: serial retry across candidates.
  if (candidates.length === 1) {
    throwIfAborted(signal);
    const attempt = startAttempt(candidates[0], 0);
    const result = await attempt.promise;
    if (result.ok) return result.response;
    if (signal.aborted) throw result.error;
    throw makeFailure(result.message);
  }

  // Hedged first wave: start #1 now, launch #2 after short delay if #1 still pending.
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

  // Remaining candidates keep serial semantics to avoid over-fanout.
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

async function autoRequestCompat(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  cfCheck: CfCheckResult,
): Promise<HttpResponse> {
  const isStreamBody = body instanceof ReadableStream;
  const idempotent = isMethodIdempotent(options.method);

  if (cfCheck.isCf && cfCheck.ipv4) {
    // Target is behind CF CDN — direct connect will fail ("TCP Loop detected").
    // Try NAT64 prefixes with full TLS+HTTP requests, each with a short timeout.
    const candidates = getNat64Candidates(cfCheck.ipv4);
    return await tryWithNat64(
      candidates,
      parsed,
      signal,
      isStreamBody,
      idempotent,
      "autoRequest:compat",
      (candidate, s) => autoRequestWithSocket(parsed, options, body, s, candidate.connectHostname),
    );
  }

  // Non-CF target — use protocol cache to skip ALPN on repeat visits
  const cached = getCachedProtocol(parsed.hostname, parsed.port);

  if (cached === "h2") {
    try {
      return await h2RequestWithConnect(parsed, options, body, true, signal);
    } catch (err) {
      if (!isCloudflareNetworkError(err)) throw err;
      // ReadableStream body may have been consumed — skip NAT64 fallback
      if (isStreamBody) throw err;
    }
  } else if (cached === "http/1.1") {
    try {
      return await http11RequestWithConnect(parsed, options, body, true, signal);
    } catch (err) {
      if (!isCloudflareNetworkError(err)) throw err;
      if (isStreamBody) throw err;
    }
  } else {
    // No protocol cache — try WASM TLS ALPN with a short handshake timeout.
    // If WASM TLS hangs (incompatible server), fall back to platform TLS h1.
    const wasmAlpnSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(WASM_TLS_HANDSHAKE_TIMEOUT),
    ]);
    try {
      return await autoRequestWithSocket(parsed, options, body, wasmAlpnSignal);
    } catch (err) {
      // If the outer request signal was aborted, propagate immediately
      if (signal.aborted) throw err;
      // WASM TLS timed out or failed — try platform TLS h1
      if (isStreamBody) throw err;
      console.debug(
        `[autoRequest:compat] ${parsed.hostname} WASM TLS ALPN failed, falling back to platform TLS h1: ${err instanceof Error ? err.message : err}`,
      );
      try {
        const result = await http11RequestWithConnect(parsed, options, body, true, signal);
        setCachedProtocol(parsed.hostname, parsed.port, "http/1.1");
        return result;
      } catch (platformErr) {
        if (!isCloudflareNetworkError(platformErr)) throw platformErr;
        if (isStreamBody) throw platformErr;
      }
    }
  }

  // Direct connection blocked but not detected as CF — try NAT64 as last resort
  throwIfAborted(signal);
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
    "autoRequest:compat",
    (candidate, s) => autoRequestWithSocket(parsed, options, body, s, candidate.connectHostname),
    () => `Connection blocked and all NAT64 prefixes failed for ${parsed.hostname}:${parsed.port}`,
  );
}

/** fast-h1 strategy: platform TLS for non-CF, WASM TLS h1-only for CF */
async function autoRequestFastH1(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  cfCheck: CfCheckResult,
): Promise<HttpResponse> {
  const isStreamBody = body instanceof ReadableStream;
  const idempotent = isMethodIdempotent(options.method);

  if (cfCheck.isCf && cfCheck.ipv4) {
    // Target is behind CF CDN — NAT64 + WASM TLS h1-only
    const candidates = getNat64Candidates(cfCheck.ipv4);
    return await tryWithNat64(
      candidates,
      parsed,
      signal,
      isStreamBody,
      idempotent,
      "autoRequest:fast-h1",
      (candidate, s) =>
        http11RequestWithWasmTLS(parsed, options, body, s, candidate.connectHostname),
    );
  }

  // Non-CF target — platform TLS (secureTransport: "on") for speed
  try {
    return await http11RequestWithConnect(parsed, options, body, true, signal);
  } catch (err) {
    // ReadableStream body may have been consumed — skip fallback
    if (isStreamBody) throw err;
    // Fallback to WASM TLS h1 on recoverable platform TLS failures
    if (shouldFallbackToWasmTls(err, signal)) {
      console.debug(
        `[autoRequest:fast-h1] ${parsed.hostname} platform TLS failed, falling back to WASM TLS: ${err instanceof Error ? err.message : err}`,
      );
      try {
        return await http11RequestWithWasmTLS(parsed, options, body, signal, parsed.hostname);
      } catch (wasmErr) {
        // If WASM also fails with a CF network error, fall through to NAT64
        if (!isCloudflareNetworkError(wasmErr)) {
          const origMsg = err instanceof Error ? err.message : String(err);
          const wasmMsg = wasmErr instanceof Error ? wasmErr.message : String(wasmErr);
          throw new Error(`Platform TLS failed: ${origMsg}; WASM fallback also failed: ${wasmMsg}`);
        }
      }
    }
    if (!isCloudflareNetworkError(err)) throw err;
  }

  // Direct connection blocked but not detected as CF — try NAT64 as last resort
  throwIfAborted(signal);
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
    "autoRequest:fast-h1",
    (candidate, s) => http11RequestWithWasmTLS(parsed, options, body, s, candidate.connectHostname),
    () => `Connection blocked and all NAT64 prefixes failed for ${parsed.hostname}:${parsed.port}`,
  );
}

/**
 * Determine if a platform TLS error should trigger fallback to WASM TLS.
 *  Excludes user/request-level timeouts (signal already aborted).
 */
function shouldFallbackToWasmTls(err: unknown, signal: AbortSignal): boolean {
  // If the request-level signal is already aborted, this is a user or
  // doRequest timeout — no point retrying with WASM TLS.
  if (signal.aborted) return false;
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("Stream was cancelled") ||
    msg.includes("connection refused") ||
    msg.includes("network connection lost") ||
    isCloudflareNetworkError(err)
  );
}

/**
 * Race an async connect against an AbortSignal.
 * If the signal fires before connect completes, cleanup is called on the
 * late-arriving result and the signal's reason is thrown.
 */
async function abortableConnect<T>(
  connectFn: () => Promise<T>,
  signal: AbortSignal,
  cleanup: (v: T) => void = v => {
    (v as { destroy?: () => void }).destroy?.();
  },
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

async function autoRequestWithSocket(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  connectHostname?: string,
): Promise<HttpResponse> {
  throwIfAborted(signal);
  const wasmSocket = await abortableConnect(
    () =>
      createWasmTLSSocket(
        parsed.hostname,
        parsed.port,
        ["h2", "http/1.1"],
        connectHostname,
        signal,
      ),
    signal,
  );

  const alpn = wasmSocket.negotiatedAlpn;

  // Cache the negotiated protocol for future requests
  if (!connectHostname) {
    setCachedProtocol(parsed.hostname, parsed.port, alpn === "h2" ? "h2" : "http/1.1");
  }

  if (alpn === "h2") {
    // Server supports HTTP/2 — use the already-established TLS connection
    const connection = new Http2Connection(wasmSocket, {
      settingsTimeout: options.timeout ?? 5000,
    });
    await connection.startInitialize();
    const client = Http2Client.fromConnection(connection);

    const onAbort = () => {
      client.close().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await client.request(parsed, {
        method: options.method,
        headers: options.headers,
        body,
        headersTimeout: options.headersTimeout,
        bodyTimeout: options.bodyTimeout,
      });
      signal.removeEventListener("abort", onAbort);
      const poolOrigin = { hostname: parsed.hostname, port: parsed.port, connectHostname };
      return wrapResponse(
        response.status,
        "",
        response.headers,
        response.rawHeaders,
        "h2",
        response.body,
        client,
        null,
        poolOrigin,
        options.decompress,
      );
    } catch (err) {
      signal.removeEventListener("abort", onAbort);
      await client.close().catch(() => {});
      throw err;
    }
  }

  // ALPN negotiated http/1.1 (or no ALPN) — use the socket for HTTP/1.1
  const onAbort = () => {
    wasmSocket.destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });

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

    signal.removeEventListener("abort", onAbort);
    return wrapResponse(
      response.status,
      response.statusText,
      response.headers,
      response.rawHeaders,
      "http/1.1",
      response.body,
      null,
      wasmSocket,
      null,
      options.decompress,
    );
  } catch (err) {
    signal.removeEventListener("abort", onAbort);
    wasmSocket.destroy();
    throw err;
  }
}

async function h2Request(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const tls = parsed.protocol === "https";

  const isStreamBody = body instanceof ReadableStream;
  const idempotent = isMethodIdempotent(options.method);

  // Pre-detect CF CDN targets via DNS
  if (tls) {
    throwIfAborted(signal);
    const cfCheck = await resolveAndCheckCloudflareCached(parsed.hostname);
    if (cfCheck.isCf && cfCheck.ipv4) {
      const candidates = getNat64Candidates(cfCheck.ipv4);
      return await tryWithNat64(
        candidates,
        parsed,
        signal,
        isStreamBody,
        idempotent,
        "h2Request",
        (candidate, s) =>
          h2RequestWithConnect(parsed, options, body, tls, s, candidate.connectHostname),
        () => `All NAT64 prefixes failed for ${parsed.hostname}:${parsed.port}`,
      );
    }
  }

  try {
    return await h2RequestWithConnect(parsed, options, body, tls, signal);
  } catch (err) {
    if (!isCloudflareNetworkError(err)) throw err;
  }

  // Direct connection blocked — try NAT64 as last resort
  throwIfAborted(signal);
  const ipv4 = await resolveNat64IPv4(parsed.hostname);
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
    "h2Request",
    (candidate, s) =>
      h2RequestWithConnect(parsed, options, body, tls, s, candidate.connectHostname),
    () => `Connection blocked and all NAT64 prefixes failed for ${parsed.hostname}:${parsed.port}`,
  );
}

async function h2RequestWithConnect(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  tls: boolean,
  signal: AbortSignal,
  connectHostname?: string,
): Promise<HttpResponse> {
  throwIfAborted(signal);

  // Try connection pool first (supports both direct and NAT64 connections)
  let client: Http2Client | null = null;
  let fromPool = false;
  client = getPooledClient(parsed.hostname, parsed.port, connectHostname);
  if (client) fromPool = true;

  if (!client) {
    client = await abortableConnect(
      () =>
        Http2Client.connect(
          parsed.hostname,
          parsed.port,
          tls,
          { settingsTimeout: options.timeout ?? 5000 },
          connectHostname,
          signal,
        ),
      signal,
      c => c.close().catch(() => {}),
    );
  }

  const onAbort = () => {
    client?.close().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await client.request(parsed, {
      method: options.method,
      headers: options.headers,
      body,
      headersTimeout: options.headersTimeout,
      bodyTimeout: options.bodyTimeout,
    });

    signal.removeEventListener("abort", onAbort);
    // Return to pool after body consumed
    const poolOrigin = { hostname: parsed.hostname, port: parsed.port, connectHostname };
    return wrapResponse(
      response.status,
      "",
      response.headers,
      response.rawHeaders,
      "h2",
      response.body,
      client,
      null,
      poolOrigin,
      options.decompress,
    );
  } catch (err) {
    signal.removeEventListener("abort", onAbort);
    if (fromPool) {
      // Pooled connection failed — remove from pool and retry with fresh connection
      removePooled(parsed.hostname, parsed.port, connectHostname);
      throwIfAborted(signal);
      const freshClient = await abortableConnect(
        () =>
          Http2Client.connect(
            parsed.hostname,
            parsed.port,
            tls,
            { settingsTimeout: options.timeout ?? 5000 },
            connectHostname,
            signal,
          ),
        signal,
        c => c.close().catch(() => {}),
      );

      const onAbort2 = () => {
        freshClient.close().catch(() => {});
      };
      signal.addEventListener("abort", onAbort2, { once: true });

      try {
        const response = await freshClient.request(parsed, {
          method: options.method,
          headers: options.headers,
          body,
          headersTimeout: options.headersTimeout,
          bodyTimeout: options.bodyTimeout,
        });
        signal.removeEventListener("abort", onAbort2);
        const poolOrigin = { hostname: parsed.hostname, port: parsed.port, connectHostname };
        return wrapResponse(
          response.status,
          "",
          response.headers,
          response.rawHeaders,
          "h2",
          response.body,
          freshClient,
          null,
          poolOrigin,
          options.decompress,
        );
      } catch (retryErr) {
        signal.removeEventListener("abort", onAbort2);
        await freshClient.close().catch(() => {});
        throw retryErr;
      }
    }
    await client.close().catch(() => {});
    throw err;
  }
}

async function http11Request(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const tls = parsed.protocol === "https";
  const isStreamBody = body instanceof ReadableStream;
  const idempotent = isMethodIdempotent(options.method);

  // Pre-detect CF CDN targets via DNS
  if (tls) {
    throwIfAborted(signal);
    const cfCheck = await resolveAndCheckCloudflareCached(parsed.hostname);
    console.debug(
      `[http11Request] ${parsed.hostname} isCf=${cfCheck.isCf} ipv4=${cfCheck.ipv4} dnsMs=${cfCheck.dnsMs}`,
    );

    if (cfCheck.isCf && cfCheck.ipv4) {
      // Target is behind CF CDN — try NAT64 candidates with full TLS+HTTP requests
      const candidates = getNat64Candidates(cfCheck.ipv4);
      return await tryWithNat64(
        candidates,
        parsed,
        signal,
        isStreamBody,
        idempotent,
        "http11Request",
        (candidate, s) =>
          http11RequestWithWasmTLS(parsed, options, body, s, candidate.connectHostname),
      );
    }
  }

  // Non-CF target — standard connection path
  try {
    return await http11RequestWithConnect(parsed, options, body, tls, signal);
  } catch (err) {
    if (!isCloudflareNetworkError(err)) throw err;
  }

  // Direct connection blocked but not detected as CF — try NAT64 as last resort
  throwIfAborted(signal);
  const ipv4 = await resolveNat64IPv4(parsed.hostname);
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
    "http11Request",
    (candidate, s) => http11RequestWithWasmTLS(parsed, options, body, s, candidate.connectHostname),
    () => `Connection blocked and all NAT64 prefixes failed for ${parsed.hostname}:${parsed.port}`,
  );
}

/** HTTP/1.1 request via WASM TLS socket (for NAT64 — ensures SNI = original hostname) */
async function http11RequestWithWasmTLS(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  connectHostname: string,
): Promise<HttpResponse> {
  throwIfAborted(signal);
  const wasmSocket = await abortableConnect(
    () => createWasmTLSSocket(parsed.hostname, parsed.port, ["http/1.1"], connectHostname, signal),
    signal,
  );

  const onAbort = () => wasmSocket.destroy();
  signal.addEventListener("abort", onAbort, { once: true });

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

    signal.removeEventListener("abort", onAbort);
    return wrapResponse(
      response.status,
      response.statusText,
      response.headers,
      response.rawHeaders,
      "http/1.1",
      response.body,
      null,
      wasmSocket,
      null,
      options.decompress,
    );
  } catch (err) {
    signal.removeEventListener("abort", onAbort);
    wasmSocket.destroy();
    throw err;
  }
}

async function http11RequestWithConnect(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  tls: boolean,
  signal: AbortSignal,
): Promise<HttpResponse> {
  throwIfAborted(signal);
  const socket = await abortableConnect(
    () => createSocket(parsed.hostname, parsed.port, tls, signal),
    signal,
  );

  const onAbort = () => socket.destroy();
  signal.addEventListener("abort", onAbort, { once: true });

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

    signal.removeEventListener("abort", onAbort);
    return wrapResponse(
      response.status,
      response.statusText,
      response.headers,
      response.rawHeaders,
      "http/1.1",
      response.body,
      null,
      socket,
      null,
      options.decompress,
    );
  } catch (err) {
    signal.removeEventListener("abort", onAbort);
    socket.destroy();
    throw err;
  }
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
  const reader = response.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
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

function normalizeBody(
  body: Uint8Array | string | ReadableStream<Uint8Array> | null | undefined,
): Uint8Array | ReadableStream<Uint8Array> | null {
  if (!body) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body; // Uint8Array or ReadableStream pass through
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

// normalizeHeaders is now imported from ./utils/headers.js
export { normalizeHeaders } from "./utils/headers.js";

/**
 * Wrap a ReadableStream so that cleanup runs automatically when the stream
 * finishes (done), is cancelled, or errors — regardless of whether the
 * consumer uses .text()/.json() or reads .body directly.
 */
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

function wrapResponse(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  rawHeaders: Array<[string, string]>,
  protocol: "h2" | "http/1.1",
  body: ReadableStream<Uint8Array>,
  h2Client?: Http2Client | null,
  socket?: Duplex | null,
  poolOrigin?: { hostname: string; port: number; connectHostname?: string } | null,
  decompress?: boolean,
): HttpResponse {
  // Transparent decompression: pipe through DecompressionStream BEFORE cleanup wrapper.
  // If accept-encoding was sent (decompress !== false), server may respond with
  // content-encoding: gzip/deflate. Decompress here so consumers get plain data.
  // When decompress=false, accept-encoding is not sent, so server won't compress.
  const encoding = headers["content-encoding"]?.toLowerCase().trim();
  if (decompress !== false && (encoding === "gzip" || encoding === "deflate")) {
    body = body.pipeThrough(new DecompressionStream(encoding));
    delete headers["content-encoding"];
    delete headers["content-length"];
    rawHeaders = rawHeaders.filter(([n]) => n !== "content-encoding" && n !== "content-length");
  }

  // Resource cleanup: return H2 client to pool or close, destroy socket
  const cleanup = () => {
    if (h2Client) {
      if (poolOrigin && h2Client.hasCapacity) {
        poolClient(poolOrigin.hostname, poolOrigin.port, h2Client, poolOrigin.connectHostname);
      } else {
        h2Client.close().catch(() => {});
      }
      h2Client = null;
    }
    if (socket) {
      socket.destroy();
      socket = null;
    }
  };

  // Wrap body: cleanup triggers automatically on done/cancel/error
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
    // cleanup already triggered by wrappedBody pull done

    if (chunks.length === 1) return chunks[0];
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  };

  return {
    status,
    statusText,
    headers,
    rawHeaders,
    protocol,
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

// ── Retry helpers ──────────────────────────────────────────────

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
