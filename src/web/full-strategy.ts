/**
 * Full request strategy — DoH detection, CF CDN bypass, NAT64 fallback, WASM TLS.
 * Only imported by the full entry (src/web/index.ts), never by lite.
 */
import type { ParsedUrl } from "../utils/url.js";
import type { InnerRequestFn, WasmTransport, HttpResponse, PrewarmDnsOptions } from "./client.js";
import {
  isCloudflareNetworkError,
  resolveIPv4,
  resolveAndCheckCloudflare,
  NAT64_PREFIXES,
  ipv4ToNAT64,
  type CfCheckResult,
} from "../socket/nat64.js";
import { rankNat64Prefixes, recordNat64PrefixResult } from "../socket/nat64-health.js";
import { getCachedDns, setCachedDns } from "../dns-cache.js";
import { http1Request } from "./http1/client.js";
import {
  type NormalizedOptions,
  h1RequestDirect,
  wrapResponse,
  abortableConnect,
  throwIfAborted,
  sleep,
} from "./request-utils.js";

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

// ── Full strategy factory ──

export function createFullStrategy(wasmTransport: WasmTransport): InnerRequestFn {
  async function h1RequestWithWasmTLS(
    parsed: ParsedUrl,
    options: NormalizedOptions,
    body: Uint8Array | ReadableStream<Uint8Array> | null,
    signal: AbortSignal,
    connectHostname: string,
  ): Promise<HttpResponse> {
    throwIfAborted(signal);
    const wasmSocket = await abortableConnect(
      () =>
        wasmTransport.connect(parsed.hostname, parsed.port, ["http/1.1"], connectHostname, signal),
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

  return async function fullDoRequestInner(
    parsed: ParsedUrl,
    options: NormalizedOptions,
    body: Uint8Array | ReadableStream<Uint8Array> | null,
    signal: AbortSignal,
  ): Promise<HttpResponse> {
    const tls = parsed.protocol === "https";
    const isStreamBody = body instanceof ReadableStream;
    const idempotent = isMethodIdempotent(options.method);

    if (tls) {
      // DoH + CF detection → NAT64 fallback
      throwIfAborted(signal);
      const cfCheck = await resolveAndCheckCloudflareCached(parsed.hostname);
      console.debug(
        `[web:request] ${parsed.hostname} isCf=${cfCheck.isCf} ipv4=${cfCheck.ipv4} dnsMs=${cfCheck.dnsMs}`,
      );

      if (cfCheck.isCf && cfCheck.ipv4) {
        try {
          wasmTransport.preload();
        } catch (err) {
          console.debug("[web:request] WASM preload failed (best-effort)", err);
        }
        const candidates = getNat64Candidates(cfCheck.ipv4);
        return await tryWithNat64(
          candidates,
          parsed,
          signal,
          isStreamBody,
          idempotent,
          (candidate, s) =>
            h1RequestWithWasmTLS(parsed, options, body, s, candidate.connectHostname),
        );
      }

      try {
        return await h1RequestDirect(parsed, options, body, true, signal);
      } catch (err) {
        if (!isCloudflareNetworkError(err) || isStreamBody) throw err;
      }

      // Direct blocked → NAT64 fallback
      throwIfAborted(signal);
      try {
        wasmTransport.preload();
      } catch (err) {
        console.debug("[web:request] WASM preload failed on fallback (best-effort)", err);
      }
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

    return h1RequestDirect(parsed, options, body, false, signal);
  };
}

// ── Public API: prewarmDns (depends on DoH, belongs here not in client.ts) ──

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

  if (isStreamBody) {
    throwIfAborted(signal);
    const attempt = startAttempt(candidates[0], 0);
    const result = await attempt.promise;
    if (result.ok) return result.response;
    if (signal.aborted) throw result.error;
    throw makeFailure(result.message);
  }

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
        loser.promise
          .then(r => {
            if (r.ok) {
              r.response.body.cancel().catch((err: unknown) => {
                console.debug("[web:request] hedged loser body cancel failed", err);
              });
            }
          })
          .catch((err: unknown) => {
            console.debug("[web:request] hedged loser cleanup failed", err);
          });
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
    throw error;
  }

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

// ── Re-exports for full entry ──

export { clearDnsCache } from "../dns-cache.js";
export { clearNat64PrefixStats } from "../socket/nat64-health.js";
