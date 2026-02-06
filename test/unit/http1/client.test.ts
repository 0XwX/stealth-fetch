import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import { http1Request } from "../../../src/http1/client.js";

/**
 * Create a mock Duplex socket using PassThrough.
 * Captures all written data for assertion.
 */
function createMockSocket() {
  const written: Buffer[] = [];
  const socket = new PassThrough();

  // Intercept writes to capture data
  const originalWrite = socket.write.bind(socket);
  socket.write = (chunk: unknown, ...args: unknown[]): boolean => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    written.push(buf);
    // Call the callback if provided
    const cb =
      typeof args[0] === "function" ? args[0] : typeof args[1] === "function" ? args[1] : null;
    if (cb) (cb as (err?: Error | null) => void)(null);
    return true;
  };

  return { socket, written, pushResponse: (data: string) => originalWrite(Buffer.from(data)) };
}

describe("http1Request with ReadableStream body", () => {
  it("should send ReadableStream body with chunked transfer encoding", async () => {
    const { socket, written, pushResponse } = createMockSocket();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.enqueue(new TextEncoder().encode(" world"));
        controller.close();
      },
    });

    // Start request (async — will write headers + body, then wait for response)
    const responsePromise = http1Request(socket, {
      method: "POST",
      path: "/test",
      hostname: "example.com",
      headers: {},
      body,
    });

    // Give time for the request body to be written
    await new Promise(resolve => setTimeout(resolve, 50));

    // Push a response to complete the request
    pushResponse("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");

    const response = await responsePromise;
    expect(response.status).toBe(200);

    // Verify written data contains chunked encoding
    const allWritten = Buffer.concat(written).toString();

    // Should contain Transfer-Encoding: chunked header
    expect(allWritten).toContain("transfer-encoding: chunked");

    // Should contain chunked body format: size\r\ndata\r\n
    expect(allWritten).toContain("5\r\nhello\r\n");
    expect(allWritten).toContain("6\r\n world\r\n");

    // Should contain terminating chunk
    expect(allWritten).toContain("0\r\n\r\n");

    // Should NOT contain content-length (unknown for streams)
    expect(allWritten).not.toContain("content-length");
  });

  it("should call reader.cancel on socket write error", async () => {
    const socket = new PassThrough();
    let cancelCalled = false;

    // Make write fail on second call (first call writes headers, subsequent calls write body chunks)
    let writeCount = 0;
    socket.write = (_chunk: unknown, ...args: unknown[]): boolean => {
      writeCount++;
      const cb =
        typeof args[0] === "function" ? args[0] : typeof args[1] === "function" ? args[1] : null;
      if (writeCount > 1) {
        // Fail after headers are written
        if (cb) (cb as (err?: Error | null) => void)(new Error("socket write failed"));
        return false;
      }
      if (cb) (cb as (err?: Error | null) => void)(null);
      return true;
    };

    // Use pull-based stream so the stream is NOT closed before cancel is called.
    // If we use start()+close(), the stream is already closed when reader.cancel()
    // is called, and the cancel callback won't fire.
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode("data"));
        }
        // Don't close — let cancel terminate the stream
      },
      cancel() {
        cancelCalled = true;
      },
    });

    await expect(
      http1Request(socket, {
        method: "POST",
        path: "/test",
        hostname: "example.com",
        headers: {},
        body,
      }),
    ).rejects.toThrow("socket write failed");

    // reader.cancel() is async — wait for the cancel callback to propagate
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(cancelCalled).toBe(true);
  });

  it("should send empty ReadableStream with only terminating chunk", async () => {
    const { socket, written, pushResponse } = createMockSocket();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    const responsePromise = http1Request(socket, {
      method: "POST",
      path: "/test",
      hostname: "example.com",
      headers: {},
      body,
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    pushResponse("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");

    const response = await responsePromise;
    expect(response.status).toBe(200);

    const allWritten = Buffer.concat(written).toString();
    // Should have chunked encoding header
    expect(allWritten).toContain("transfer-encoding: chunked");
    // Should contain only the terminating chunk (no data chunks)
    expect(allWritten).toContain("0\r\n\r\n");
  });
});

describe("http1Request timeouts", () => {
  it("should timeout waiting for response headers", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = createMockSocket();

      const responsePromise = http1Request(socket, {
        method: "GET",
        path: "/timeout",
        hostname: "example.com",
        headers: {},
        headersTimeout: 10,
      });

      await vi.advanceTimersByTimeAsync(20);
      await expect(responsePromise).rejects.toThrow("Headers timeout after 10ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should timeout waiting for response body data", async () => {
    vi.useFakeTimers();
    try {
      const { socket, pushResponse } = createMockSocket();

      const responsePromise = http1Request(socket, {
        method: "GET",
        path: "/body-timeout",
        hostname: "example.com",
        headers: {},
        bodyTimeout: 10,
      });

      // Send headers with a non-zero content-length, but no body
      pushResponse("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n");

      const response = await responsePromise;
      const reader = response.body.getReader();
      const readPromise = reader.read();

      await vi.advanceTimersByTimeAsync(20);
      await expect(readPromise).rejects.toThrow("Body timeout after 10ms");
    } finally {
      vi.useRealTimers();
    }
  });
});
