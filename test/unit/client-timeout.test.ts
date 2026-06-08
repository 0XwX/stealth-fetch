import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Http1Response } from "../../src/http1/client.js";

const mocks = vi.hoisted(() => ({
  createSocket: vi.fn(),
  http1Request: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("../../src/socket/tls.js", () => ({
  createSocket: mocks.createSocket,
  createPlainSocket: vi.fn(),
  createTLSSocket: vi.fn(),
  createWasmTLSSocket: vi.fn(),
}));

vi.mock("../../src/http1/client.js", () => ({
  http1Request: mocks.http1Request,
}));

vi.mock("../../src/socket/nat64.js", () => ({
  NAT64_PREFIXES: [],
  isCloudflareNetworkError: () => false,
  ipv4ToNAT64: (ip: string) => ip,
  resolveIPv4: vi.fn().mockResolvedValue(null),
  resolveAndCheckCloudflare: vi.fn().mockResolvedValue({
    isCf: false,
    ipv4: null,
    dnsMs: 0,
    ttl: 60,
  }),
}));

vi.mock("../../src/socket/wasm-tls-bridge.js", () => ({
  preloadWasmTls: vi.fn(),
}));

vi.mock("../../src/http2/hpack.js", () => ({
  preloadHpack: vi.fn(),
  HpackEncoder: class {},
  HpackDecoder: class {},
}));

const { request } = await import("../../src/index.js");

function abortableNever(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener(
      "abort",
      () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

function okResponse(): Http1Response {
  return {
    status: 200,
    statusText: "OK",
    headers: {},
    rawHeaders: [],
    protocol: "http/1.1",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("User-Agent"));
        controller.close();
      },
    }),
  };
}

describe("Request Timeout", () => {
  beforeEach(() => {
    mocks.createSocket.mockReset();
    mocks.http1Request.mockReset();
    mocks.destroy.mockReset();
  });

  it("should throw TimeoutError for very short timeout", async () => {
    mocks.createSocket.mockImplementation((_host, _port, _tls, signal) => abortableNever(signal));

    await expect(
      request("https://example.com/delay/5", { timeout: 1, protocol: "http/1.1" }),
    ).rejects.toThrow(/timed out/i);
  });

  it("should throw TimeoutError with custom timeout value in message", async () => {
    mocks.createSocket.mockImplementation((_host, _port, _tls, signal) => abortableNever(signal));

    try {
      await request("https://example.com/delay/5", { timeout: 50, protocol: "http/1.1" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("TimeoutError");
      expect((err as DOMException).message).toContain("50ms");
    }
  });

  it("should respect user-provided AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("User cancelled", "AbortError"));

    await expect(
      request("https://example.com/headers", { signal: controller.signal }),
    ).rejects.toThrow("User cancelled");
  });

  it("should throw immediately if signal is already aborted before request", async () => {
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    await expect(
      request("https://example.com/headers", { signal: controller.signal }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
  });

  it("should succeed with a generous timeout", async () => {
    mocks.createSocket.mockResolvedValue({ destroy: mocks.destroy });
    mocks.http1Request.mockResolvedValue(okResponse());

    const response = await request("https://example.com/headers", {
      timeout: 15000,
      protocol: "http/1.1",
      headers: { "User-Agent": "timeout-test/1.0" },
    });

    expect(response.status).toBe(200);
    expect(response.protocol).toBe("http/1.1");
    const text = await response.text();
    expect(text).toContain("User-Agent");
    expect(mocks.destroy).toHaveBeenCalled();
  });
});
