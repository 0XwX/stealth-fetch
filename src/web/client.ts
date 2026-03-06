/**
 * Web entry request pipeline shell — redirect, retry, timeout.
 * No DoH, no NAT64, no WASM dependencies.
 * Strategy for single-request dispatch is injected via InnerRequestFn.
 */
import { parseUrl, type ParsedUrl } from "../utils/url.js";
import { normalizeHeaders, type HeaderInput } from "../utils/headers.js";
import {
  type NormalizedOptions,
  type HttpResponseShape,
  h1RequestDirect,
  normalizeBody,
  compressRequestBody,
  resolveRedirectUrl,
  isOriginChange,
  consumeAndDiscard,
  throwIfAborted,
  hasHeader,
  sleep,
} from "./request-utils.js";

// ── WASM Transport interface (used by full-strategy, not needed by lite) ──

export interface WasmTlsLike {
  write(d: Uint8Array): Promise<void>;
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  close(): void;
  readonly closed: boolean;
  readonly negotiatedAlpn: string | null;
}

export interface WasmTransport {
  preload(): void;
  connect(
    hostname: string,
    port: number,
    alpn: string[],
    connectHostname: string,
    signal: AbortSignal,
  ): Promise<WasmTlsLike>;
}

// ── Public types ──

export interface RetryOptions {
  limit?: number;
  methods?: string[];
  statusCodes?: number[];
  maxDelay?: number;
  baseDelay?: number;
}

export interface RequestOptions {
  method?: string;
  headers?: HeaderInput;
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

export type HttpResponse = HttpResponseShape;

export interface PrewarmDnsOptions {
  concurrency?: number;
  signal?: AbortSignal;
  ignoreErrors?: boolean;
}

// ── Strategy type: pluggable single-request dispatch ──

export type InnerRequestFn = (
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
) => Promise<HttpResponse>;

// ── Factory: createRequestFn ──

export function createRequestFn(
  doRequestInner?: InnerRequestFn,
): (url: string, options?: RequestOptions) => Promise<HttpResponse> {
  // Default strategy: platform TLS direct (lite path)
  const inner: InnerRequestFn =
    doRequestInner ??
    ((parsed, opts, body, signal) =>
      h1RequestDirect(parsed, opts, body, parsed.protocol === "https", signal));

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

      const response = await inner(parsed, reqOptions, body, signal);
      if (redirect !== "follow" || response.status < 300 || response.status >= 400) return response;

      redirectCount++;
      if (redirectCount > maxRedirects)
        throw new Error(`Maximum redirects (${maxRedirects}) exceeded`);

      const location = response.headers["location"];
      if (!location) return response;
      await consumeAndDiscard(response);

      const resolvedUrl = resolveRedirectUrl(currentUrl, location);
      const newParsed = parseUrl(resolvedUrl);
      if (parsed.protocol === "https" && newParsed.protocol === "http") {
        throw new Error(`Refused to follow redirect from HTTPS to HTTP: ${resolvedUrl}`);
      }
      if (visitedUrls.has(resolvedUrl)) throw new Error(`Redirect loop detected: ${resolvedUrl}`);
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

  return async function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
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
            const delay = calculateRetryDelay(
              response.headers["retry-after"],
              attempt,
              retryConfig,
            );
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
  };
}

// ── Re-exports ──

export { normalizeHeaders } from "../utils/headers.js";

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
    if (!isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, config.maxDelay);
    const date = Date.parse(retryAfterHeader);
    if (!isNaN(date)) {
      const ms = date - Date.now();
      if (ms > 0) return Math.min(ms, config.maxDelay);
    }
  }
  return Math.min(config.baseDelay * 2 ** attempt, config.maxDelay);
}
