/**
 * Shared request utilities — no WASM dependencies.
 * Used by client.ts and potentially by stealth-fetch-lite.
 */
import { http1Request } from "./http1/client.js";
import { concatBytes, encode } from "./bytes.js";
import { type ParsedUrl } from "../utils/url.js";
import { createRawSocket } from "./raw-socket.js";

// ── Closable socket abstraction ──

export interface Closable {
  close(): void;
}

// ── Types re-used by client.ts ──

export interface NormalizedOptions {
  method?: string;
  headers: Record<string, string>;
  timeout?: number;
  headersTimeout?: number;
  bodyTimeout?: number;
  decompress?: boolean;
}

export interface HttpResponseShape {
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

// ── Transport: direct H1 request via platform TLS ──

export async function h1RequestDirect(
  parsed: ParsedUrl,
  options: NormalizedOptions,
  body: Uint8Array | ReadableStream<Uint8Array> | null,
  tls: boolean,
  signal: AbortSignal,
): Promise<HttpResponseShape> {
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

// ── Response wrapping ──

export function wrapResponse(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  rawHeaders: Array<[string, string]>,
  body: ReadableStream<Uint8Array>,
  socket: Closable | null,
  decompress?: boolean,
): HttpResponseShape {
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
    if (result instanceof Promise)
      result.catch((err: unknown) => console.debug("[request-utils] auto-cleanup failed", err));
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

// ── Generic helpers ──

export async function abortableConnect<T>(
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

export function normalizeBody(
  body: Uint8Array | string | ReadableStream<Uint8Array> | null | undefined,
): Uint8Array | ReadableStream<Uint8Array> | null {
  if (!body) return null;
  if (typeof body === "string") return encode(body);
  return body;
}

export async function compressRequestBody(data: Uint8Array): Promise<Uint8Array> {
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

export function resolveRedirectUrl(baseUrl: string, location: string): string {
  if (location.startsWith("http://") || location.startsWith("https://")) {
    return location;
  }
  return new URL(location, baseUrl).href;
}

export function isOriginChange(from: ParsedUrl, to: ParsedUrl): boolean {
  return from.hostname !== to.hostname || from.port !== to.port || from.protocol !== to.protocol;
}

export async function consumeAndDiscard(response: HttpResponseShape): Promise<void> {
  await response.body.cancel();
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
