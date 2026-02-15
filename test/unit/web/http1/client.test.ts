import { describe, it, expect, vi } from "vitest";
import type { RawSocket } from "../../../../src/web/raw-socket.js";
import { http1Request } from "../../../../src/web/http1/client.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Create a mock RawSocket with push-based read queue.
 * No node:stream dependency — pure Web API types.
 */
function createMockRawSocket() {
  const written: Uint8Array[] = [];
  const readQueue: ReadableStreamReadResult<Uint8Array>[] = [];
  let readResolve: ((v: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
  let _closed = false;

  const socket: RawSocket = {
    async write(data: Uint8Array) {
      written.push(new Uint8Array(data));
    },
    read() {
      if (readQueue.length > 0) return Promise.resolve(readQueue.shift()!);
      return new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => {
        readResolve = resolve;
      });
    },
    close() {
      _closed = true;
    },
    get closed() {
      return _closed;
    },
  };

  function pushData(str: string) {
    const data = enc.encode(str);
    const result: ReadableStreamReadResult<Uint8Array> = { done: false, value: data };
    if (readResolve) {
      const r = readResolve;
      readResolve = null;
      r(result);
    } else {
      readQueue.push(result);
    }
  }

  function pushDone() {
    const result: ReadableStreamReadResult<Uint8Array> = {
      done: true,
      value: undefined,
    } as ReadableStreamReadResult<Uint8Array>;
    if (readResolve) {
      const r = readResolve;
      readResolve = null;
      r(result);
    } else {
      readQueue.push(result);
    }
  }

  return { socket, written, pushData, pushDone };
}

describe("http1Request (web/RawSocket) with ReadableStream body", () => {
  it("should send ReadableStream body with chunked transfer encoding", async () => {
    const { socket, written, pushData } = createMockRawSocket();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("hello"));
        controller.enqueue(enc.encode(" world"));
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

    // Give time for the request body to be written
    await new Promise(resolve => setTimeout(resolve, 50));

    // Push a response
    pushData("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");

    const response = await responsePromise;
    expect(response.status).toBe(200);

    // Verify written data contains chunked encoding
    const allWritten = dec.decode(
      new Uint8Array(
        written.reduce((acc, chunk) => {
          const merged = new Uint8Array(acc.length + chunk.length);
          merged.set(acc);
          merged.set(chunk, acc.length);
          return merged;
        }, new Uint8Array(0)),
      ),
    );

    expect(allWritten).toContain("transfer-encoding: chunked");
    expect(allWritten).toContain("5\r\nhello\r\n");
    expect(allWritten).toContain("6\r\n world\r\n");
    expect(allWritten).toContain("0\r\n\r\n");
    expect(allWritten).not.toContain("content-length");
  });

  it("should send empty ReadableStream with only terminating chunk", async () => {
    const { socket, written, pushData } = createMockRawSocket();

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
    pushData("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");

    const response = await responsePromise;
    expect(response.status).toBe(200);

    const allWritten = dec.decode(
      new Uint8Array(
        written.reduce((acc, chunk) => {
          const merged = new Uint8Array(acc.length + chunk.length);
          merged.set(acc);
          merged.set(chunk, acc.length);
          return merged;
        }, new Uint8Array(0)),
      ),
    );

    expect(allWritten).toContain("transfer-encoding: chunked");
    expect(allWritten).toContain("0\r\n\r\n");
  });
});

describe("http1Request (web/RawSocket) response reading", () => {
  it("should read content-length response body", async () => {
    const { socket, pushData } = createMockRawSocket();

    const responsePromise = http1Request(socket, {
      method: "GET",
      path: "/test",
      hostname: "example.com",
      headers: {},
    });

    pushData("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
    expect(response.protocol).toBe("http/1.1");

    const reader = response.body.getReader();
    const { done, value } = await reader.read();
    expect(done).toBe(false);
    expect(dec.decode(value!)).toBe("hello");

    const final = await reader.read();
    expect(final.done).toBe(true);
  });

  it("should throw when connection closes before headers", async () => {
    const { socket, pushDone } = createMockRawSocket();

    const responsePromise = http1Request(socket, {
      method: "GET",
      path: "/test",
      hostname: "example.com",
      headers: {},
    });

    pushDone();

    await expect(responsePromise).rejects.toThrow(
      "Connection closed before response headers received",
    );
  });

  it("should handle chunked response body", async () => {
    const { socket, pushData } = createMockRawSocket();

    const responsePromise = http1Request(socket, {
      method: "GET",
      path: "/test",
      hostname: "example.com",
      headers: {},
    });

    pushData("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");

    const response = await responsePromise;
    expect(response.status).toBe(200);

    // Push chunked body data
    pushData("5\r\nhello\r\n0\r\n\r\n");

    const reader = response.body.getReader();
    const { value } = await reader.read();
    expect(dec.decode(value!)).toBe("hello");

    const final = await reader.read();
    expect(final.done).toBe(true);
  });
});

describe("http1Request (web/RawSocket) timeouts", () => {
  it("should timeout waiting for response headers", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = createMockRawSocket();

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
      const { socket, pushData } = createMockRawSocket();

      const responsePromise = http1Request(socket, {
        method: "GET",
        path: "/body-timeout",
        hostname: "example.com",
        headers: {},
        bodyTimeout: 10,
      });

      // Send headers with a non-zero content-length, but no body
      pushData("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n");

      const response = await responsePromise;
      const reader = response.body.getReader();
      const readPromise = reader.read();

      await vi.advanceTimersByTimeAsync(20);
      await expect(readPromise).rejects.toThrow("Body timeout after 10ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should abort via signal even when headersTimeout is set", async () => {
    const { socket } = createMockRawSocket();
    const ac = new AbortController();

    const responsePromise = http1Request(socket, {
      method: "GET",
      path: "/signal-with-timeout",
      hostname: "example.com",
      headers: {},
      headersTimeout: 5000,
      signal: ac.signal,
    });

    // Abort immediately
    ac.abort(new DOMException("user cancel", "AbortError"));

    await expect(responsePromise).rejects.toThrow("user cancel");
  });

  it("should abort body read via signal even when bodyTimeout is set", async () => {
    const { socket, pushData } = createMockRawSocket();
    const ac = new AbortController();

    const responsePromise = http1Request(socket, {
      method: "GET",
      path: "/body-signal-with-timeout",
      hostname: "example.com",
      headers: {},
      bodyTimeout: 5000,
      signal: ac.signal,
    });

    pushData("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n");

    const response = await responsePromise;
    const reader = response.body.getReader();
    const readPromise = reader.read();

    ac.abort(new DOMException("cancel body", "AbortError"));

    await expect(readPromise).rejects.toThrow("cancel body");
  });

  it("should not leave pending timers after successful read with timeout", async () => {
    vi.useFakeTimers();
    try {
      const { socket, pushData } = createMockRawSocket();

      const responsePromise = http1Request(socket, {
        method: "GET",
        path: "/no-leak",
        hostname: "example.com",
        headers: {},
        headersTimeout: 500,
      });

      // Respond immediately — timer should be cleaned up
      pushData("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");

      const response = await responsePromise;
      expect(response.status).toBe(200);

      // Advance time well past the timeout — should NOT throw
      await vi.advanceTimersByTimeAsync(1000);

      // Consume the body to verify no errors surface
      const reader = response.body.getReader();
      const { value } = await reader.read();
      expect(dec.decode(value!)).toBe("OK");
    } finally {
      vi.useRealTimers();
    }
  });
});
