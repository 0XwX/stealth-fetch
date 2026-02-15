/**
 * HTTP/1.1 client over RawSocket (pull-based, no node:stream Duplex).
 */
import { concatBytes, encode } from "../bytes.js";
import type { RawSocket } from "../raw-socket.js";
import { serializeHttp1Headers, validateMethod, validatePath } from "../../utils/headers.js";
import { parseResponseHead, type ParsedResponse } from "./parser.js";
import { ChunkedDecoder } from "./chunked.js";

export interface Http1Request {
  method: string;
  path: string;
  hostname: string;
  headers: Record<string, string>;
  body?: Uint8Array | ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
  headersTimeout?: number;
  bodyTimeout?: number;
}

export interface Http1Response {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawHeaders: Array<[string, string]>;
  protocol: "http/1.1";
  body: ReadableStream<Uint8Array>;
}

/**
 * Send an HTTP/1.1 request over a raw socket and return the response.
 */
export async function http1Request(
  socket: RawSocket,
  request: Http1Request,
): Promise<Http1Response> {
  if (request.signal?.aborted) {
    throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  validateMethod(request.method);
  validatePath(request.path);

  // Build request headers
  const reqHeaders = { ...request.headers };
  if (!reqHeaders["host"]) {
    reqHeaders["host"] = request.hostname;
  }
  if (!reqHeaders["connection"]) {
    reqHeaders["connection"] = "close";
  }
  if (!reqHeaders["user-agent"]) {
    reqHeaders["user-agent"] = "stealth-fetch/0.1";
  }

  // RFC 7230: Transfer-Encoding takes precedence over Content-Length
  if (reqHeaders["transfer-encoding"] && reqHeaders["content-length"]) {
    delete reqHeaders["content-length"];
  }

  const isStreamBody = request.body instanceof ReadableStream;
  if (isStreamBody) {
    if (!reqHeaders["transfer-encoding"]) {
      reqHeaders["transfer-encoding"] = "chunked";
    }
    delete reqHeaders["content-length"];
  } else if (request.body && !reqHeaders["content-length"]) {
    reqHeaders["content-length"] = String((request.body as Uint8Array).byteLength);
  }

  // Serialize and write request line + headers
  const requestLine = `${request.method.toUpperCase()} ${request.path} HTTP/1.1\r\n`;
  const headersStr = serializeHttp1Headers(reqHeaders);
  const head = `${requestLine + headersStr}\r\n`;
  await socket.write(encode(head));

  // Write body
  if (isStreamBody && request.body instanceof ReadableStream) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const sizeLine = encode(`${value.byteLength.toString(16)}\r\n`);
        const suffix = encode("\r\n");
        await socket.write(concatBytes([sizeLine, value, suffix]));
      }
      await socket.write(encode("0\r\n\r\n"));
    } catch (err) {
      reader.cancel(err as Error).catch(() => {});
      throw err;
    } finally {
      reader.releaseLock();
    }
  } else if (request.body && !isStreamBody && (request.body as Uint8Array).byteLength > 0) {
    await socket.write(request.body as Uint8Array);
  }

  // Read response
  return readResponse(socket, request.signal, request.headersTimeout, request.bodyTimeout);
}

/**
 * Read and parse HTTP/1.1 response from socket (pull-based).
 */
async function readResponse(
  socket: RawSocket,
  signal?: AbortSignal,
  headersTimeout?: number,
  bodyTimeout?: number,
): Promise<Http1Response> {
  const hasHeadersTimeout =
    typeof headersTimeout === "number" && headersTimeout > 0 && headersTimeout < Infinity;

  // ── Phase 1: Read response headers ──
  let headBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let parsed: ParsedResponse | null = null;
  let bodyStartData: Uint8Array = new Uint8Array(0);

  while (true) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    let readPromise: Promise<ReadableStreamReadResult<Uint8Array>> = socket.read();
    if (hasHeadersTimeout)
      readPromise = raceTimeout(
        readPromise,
        headersTimeout!,
        `Headers timeout after ${headersTimeout}ms`,
      );
    if (signal) readPromise = raceSignal(readPromise, signal);
    const readResult = await readPromise;

    if (readResult.done) {
      throw new Error("Connection closed before response headers received");
    }

    const chunk = readResult.value;
    headBuffer = headBuffer.byteLength > 0 ? concatBytes([headBuffer, chunk]) : chunk;

    if (headBuffer.byteLength > 81920) {
      throw new Error("Response headers too large (>80KB)");
    }

    const result = parseResponseHead(headBuffer);
    if (!result) continue;

    // Skip 100 Continue
    if (result.response.status === 100) {
      headBuffer = headBuffer.subarray(result.bodyStart);
      continue;
    }

    parsed = result.response;
    bodyStartData = headBuffer.subarray(result.bodyStart);
    break;
  }

  // ── Phase 2: Create body ReadableStream ──
  const bodyStream = createBodyStream(socket, parsed!, bodyStartData, signal, bodyTimeout);

  return {
    status: parsed!.status,
    statusText: parsed!.statusText,
    headers: parsed!.headers,
    rawHeaders: parsed!.rawHeaders,
    protocol: "http/1.1",
    body: bodyStream,
  };
}

function createBodyStream(
  socket: RawSocket,
  parsed: ParsedResponse,
  initialData: Uint8Array,
  signal?: AbortSignal,
  bodyTimeout?: number,
): ReadableStream<Uint8Array> {
  const hasBodyTimeout =
    typeof bodyTimeout === "number" && bodyTimeout > 0 && bodyTimeout < Infinity;
  let chunkedDecoder: ChunkedDecoder | null = null;
  let bytesReceived = 0;
  let hasLeftover = initialData.byteLength > 0;

  if (parsed.bodyMode === "chunked") {
    chunkedDecoder = new ChunkedDecoder();
  }

  // content-length: 0
  if (parsed.bodyMode === "content-length" && parsed.contentLength === 0) {
    return new ReadableStream({
      start(c) {
        c.close();
      },
    });
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Workaround for Cloudflare Workers ReadableStream bug:
      // The runtime does not re-call pull() after it resolves without enqueue().
      // Loop internally until we either enqueue data, close, or error.
      try {
        while (true) {
          let data: Uint8Array;

          if (hasLeftover) {
            data = initialData;
            hasLeftover = false;
          } else {
            if (signal?.aborted) {
              controller.error(signal.reason ?? new DOMException("Aborted", "AbortError"));
              socket.close();
              return;
            }

            let readPromise: Promise<ReadableStreamReadResult<Uint8Array>> = socket.read();
            if (hasBodyTimeout)
              readPromise = raceTimeout(
                readPromise,
                bodyTimeout!,
                `Body timeout after ${bodyTimeout}ms`,
              );
            if (signal) readPromise = raceSignal(readPromise, signal);
            const readResult = await readPromise;

            if (readResult.done) {
              if (parsed.bodyMode === "close") {
                controller.close();
              } else if (parsed.bodyMode === "chunked" && chunkedDecoder?.done) {
                controller.close();
              } else if (
                parsed.bodyMode === "content-length" &&
                bytesReceived >= parsed.contentLength
              ) {
                controller.close();
              } else {
                controller.error(new Error("Connection closed before body complete"));
              }
              return;
            }
            data = readResult.value;
          }

          // Process data by body mode
          if (parsed.bodyMode === "chunked" && chunkedDecoder) {
            chunkedDecoder.feed(data);
            for (const chunk of chunkedDecoder.getChunks()) {
              controller.enqueue(chunk);
            }
            if (chunkedDecoder.done) {
              controller.close();
              return;
            }
            // If decoder buffered data but produced no chunks, loop to read more
            if (controller.desiredSize !== null && controller.desiredSize > 0) {
              continue;
            }
            return;
          } else if (parsed.bodyMode === "content-length") {
            const remaining = parsed.contentLength - bytesReceived;
            const toEnqueue = data.byteLength <= remaining ? data : data.subarray(0, remaining);
            bytesReceived += toEnqueue.byteLength;
            controller.enqueue(toEnqueue);
            if (bytesReceived >= parsed.contentLength) {
              controller.close();
            }
            return;
          } else {
            // "close" mode
            controller.enqueue(data);
            return;
          }
        }
      } catch (err) {
        controller.error(err);
        socket.close();
      }
    },
    cancel() {
      socket.close();
    },
  });
}

/** Race a promise against a timeout, clearing the timer when the promise settles first. */
function raceTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException(message, "TimeoutError")), ms);
    promise.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Race a promise against an AbortSignal. */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      v => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      e => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
