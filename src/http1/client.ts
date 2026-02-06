/**
 * HTTP/1.1 client over raw TCP/TLS socket.
 * Sends requests and parses responses without using fetch(),
 * thus avoiding Cloudflare's automatic cf-* header injection.
 */
import { Buffer } from "node:buffer";
import type { Duplex } from "node:stream";
import { serializeHttp1Headers } from "../utils/headers.js";
import { parseResponseHead, type ParsedResponse } from "./parser.js";
import { ChunkedDecoder } from "./chunked.js";

export interface Http1Request {
  method: string;
  path: string;
  hostname: string;
  headers: Record<string, string>;
  body?: Uint8Array | ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
  /** Timeout waiting for response headers (ms) */
  headersTimeout?: number;
  /** Timeout waiting for response body data (ms) */
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
export async function http1Request(socket: Duplex, request: Http1Request): Promise<Http1Response> {
  // Check abort before starting
  if (request.signal?.aborted) {
    throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  // Build request
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

  // RFC 7230 Section 3.3.3: Transfer-Encoding takes precedence over Content-Length
  if (reqHeaders["transfer-encoding"] && reqHeaders["content-length"]) {
    delete reqHeaders["content-length"];
  }

  const isStreamBody = request.body instanceof ReadableStream;
  if (isStreamBody) {
    // Streaming body: use chunked transfer encoding (length unknown)
    if (!reqHeaders["transfer-encoding"]) {
      reqHeaders["transfer-encoding"] = "chunked";
    }
    // Remove conflicting content-length for stream bodies
    delete reqHeaders["content-length"];
  } else if (request.body && !reqHeaders["content-length"]) {
    reqHeaders["content-length"] = String((request.body as Uint8Array).byteLength);
  }

  // Serialize request line + headers
  const requestLine = `${request.method.toUpperCase()} ${request.path} HTTP/1.1\r\n`;
  const headersStr = serializeHttp1Headers(reqHeaders);
  const head = `${requestLine + headersStr}\r\n`;

  // Write request
  await writeToSocket(socket, Buffer.from(head, "utf-8"));

  if (isStreamBody && request.body instanceof ReadableStream) {
    // Stream body: read chunks and write chunked transfer encoding
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        await writeToSocket(socket, Buffer.from(`${chunk.byteLength.toString(16)}\r\n`));
        await writeToSocket(socket, chunk);
        await writeToSocket(socket, Buffer.from("\r\n"));
      }
      // Terminating chunk
      await writeToSocket(socket, Buffer.from("0\r\n\r\n"));
    } catch (err) {
      reader.cancel(err as Error).catch(() => {});
      throw err;
    } finally {
      reader.releaseLock();
    }
  } else if (request.body && !isStreamBody && (request.body as Uint8Array).byteLength > 0) {
    await writeToSocket(socket, Buffer.from(request.body as Uint8Array));
  }

  // Read response
  return readResponse(socket, request.signal, request.headersTimeout, request.bodyTimeout);
}

function writeToSocket(socket: Duplex, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Read and parse HTTP/1.1 response from socket.
 * Returns response with a streaming body.
 */
function readResponse(
  socket: Duplex,
  signal?: AbortSignal,
  headersTimeout?: number,
  bodyTimeout?: number,
): Promise<Http1Response> {
  return new Promise((resolve, reject) => {
    let headBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let headParsed = false;
    let parsed: ParsedResponse | null = null;
    let bodyBytesReceived = 0;
    let chunkedDecoder: ChunkedDecoder | null = null;
    const hasHeadersTimeout =
      typeof headersTimeout === "number" && headersTimeout > 0 && headersTimeout < Infinity;
    const hasBodyTimeout =
      typeof bodyTimeout === "number" && bodyTimeout > 0 && bodyTimeout < Infinity;

    // We'll create a ReadableStream for the body
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let bodyStreamClosed = false;

    let headersTimer: ReturnType<typeof setTimeout> | null = null;
    let bodyTimer: ReturnType<typeof setTimeout> | null = null;
    let lastBodyActivity = 0;

    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel() {
        bodyStreamClosed = true;
        cleanup();
      },
    });

    const closeBody = () => {
      if (bodyController && !bodyStreamClosed) {
        bodyStreamClosed = true;
        try {
          bodyController.close();
        } catch {
          // ignore if already closed
        }
      }
      clearBodyTimer();
    };

    const enqueueBody = (data: Uint8Array) => {
      if (bodyController && !bodyStreamClosed) {
        try {
          bodyController.enqueue(data);
        } catch {
          // ignore if closed
        }
      }
    };

    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("error", onError);
      if (signal) signal.removeEventListener("abort", onAbort);
      clearHeadersTimer();
      clearBodyTimer();
    };

    const onAbort = () => {
      const err = signal?.reason ?? new DOMException("Aborted", "AbortError");
      if (!headParsed) {
        reject(err);
      } else if (bodyController && !bodyStreamClosed) {
        bodyStreamClosed = true;
        try {
          bodyController.error(err);
        } catch {
          // ignore
        }
      }
      cleanup();
      socket.destroy();
    };

    const clearHeadersTimer = () => {
      if (headersTimer) {
        clearTimeout(headersTimer);
        headersTimer = null;
      }
    };

    const clearBodyTimer = () => {
      if (bodyTimer) {
        clearTimeout(bodyTimer);
        bodyTimer = null;
      }
    };

    const onHeadersTimeout = () => {
      if (headParsed) return;
      const err = new DOMException(`Headers timeout after ${headersTimeout}ms`, "TimeoutError");
      reject(err);
      cleanup();
      socket.destroy();
    };

    const onBodyTimeoutCheck = () => {
      bodyTimer = null;
      if (!hasBodyTimeout) return;
      const elapsed = Date.now() - lastBodyActivity;
      if (elapsed >= bodyTimeout!) {
        const err = new DOMException(`Body timeout after ${bodyTimeout}ms`, "TimeoutError");
        if (bodyController && !bodyStreamClosed) {
          bodyStreamClosed = true;
          try {
            bodyController.error(err);
          } catch {
            // ignore
          }
        }
        cleanup();
        socket.destroy();
        return;
      }
      // Reschedule for remaining time
      bodyTimer = setTimeout(onBodyTimeoutCheck, bodyTimeout! - elapsed);
    };

    const markBodyActivity = () => {
      if (!hasBodyTimeout) return;
      lastBodyActivity = Date.now();
      if (!bodyTimer) {
        bodyTimer = setTimeout(onBodyTimeoutCheck, bodyTimeout!);
      }
    };

    const onData = (chunk: Buffer | Uint8Array) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      if (!headParsed) {
        headBuffer = headBuffer.length > 0 ? Buffer.concat([headBuffer, buf]) : buf;

        // Limit header size to 80KB to prevent memory exhaustion
        if (headBuffer.length > 81920) {
          reject(new Error("Response headers too large (>80KB)"));
          cleanup();
          return;
        }

        const result = parseResponseHead(headBuffer);
        if (!result) return; // need more data for headers

        // Skip 100 Continue intermediate responses
        if (result.response.status === 100) {
          headBuffer = headBuffer.subarray(result.bodyStart);
          return;
        }

        headParsed = true;
        parsed = result.response;
        clearHeadersTimer();

        // Resolve the promise with response (body streams separately)
        resolve({
          status: parsed.status,
          statusText: parsed.statusText,
          headers: parsed.headers,
          rawHeaders: parsed.rawHeaders,
          protocol: "http/1.1",
          body: bodyStream,
        });

        // Process any body data that came with the headers
        const bodyData = headBuffer.subarray(result.bodyStart);
        headBuffer = Buffer.alloc(0); // free memory

        if (parsed.bodyMode === "chunked") {
          chunkedDecoder = new ChunkedDecoder();
        }

        if (
          hasBodyTimeout &&
          !(parsed.bodyMode === "content-length" && parsed.contentLength === 0)
        ) {
          markBodyActivity();
        }

        if (bodyData.length > 0) {
          processBodyData(bodyData);
        }

        // Check if body is already complete (content-length: 0)
        if (parsed.bodyMode === "content-length" && parsed.contentLength === 0) {
          closeBody();
          cleanup();
        }
      } else {
        processBodyData(buf);
      }
    };

    const processBodyData = (data: Buffer) => {
      if (!parsed) return;
      if (hasBodyTimeout) {
        markBodyActivity();
      }

      if (parsed.bodyMode === "chunked" && chunkedDecoder) {
        chunkedDecoder.feed(data);
        for (const chunk of chunkedDecoder.getChunks()) {
          enqueueBody(chunk);
        }
        if (chunkedDecoder.done) {
          closeBody();
          cleanup();
        }
      } else if (parsed.bodyMode === "content-length") {
        const remaining = parsed.contentLength - bodyBytesReceived;
        const toEnqueue = data.length <= remaining ? data : data.subarray(0, remaining);
        bodyBytesReceived += toEnqueue.length;
        enqueueBody(toEnqueue);
        if (bodyBytesReceived >= parsed.contentLength) {
          closeBody();
          cleanup();
        }
      } else {
        // "close" mode: read until connection closes
        enqueueBody(data);
      }
    };

    const onEnd = () => {
      if (!headParsed) {
        reject(new Error("Connection closed before response headers received"));
      } else {
        closeBody();
      }
      cleanup();
    };

    const onError = (err: Error) => {
      if (!headParsed) {
        reject(err);
      } else {
        if (bodyController && !bodyStreamClosed) {
          bodyStreamClosed = true;
          try {
            bodyController.error(err);
          } catch {
            // ignore
          }
        }
      }
      cleanup();
    };

    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (hasHeadersTimeout) {
      headersTimer = setTimeout(onHeadersTimeout, headersTimeout!);
    }
  });
}
