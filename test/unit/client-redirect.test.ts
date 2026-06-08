import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Http1Response } from "../../src/http1/client.js";

const mocks = vi.hoisted(() => ({
  http1Request: vi.fn(),
  createSocket: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("../../src/http1/client.js", () => ({
  http1Request: mocks.http1Request,
}));

vi.mock("../../src/socket/tls.js", () => ({
  createSocket: mocks.createSocket,
  createPlainSocket: vi.fn(),
  createTLSSocket: vi.fn(),
  createWasmTLSSocket: vi.fn(),
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

const { request } = await import("../../src/client.js");

function pendingBody(cancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ cancel });
}

function response(status: number, headers: Record<string, string> = {}): Http1Response {
  return {
    status,
    statusText: status === 200 ? "OK" : "Redirect",
    headers,
    rawHeaders: Object.entries(headers),
    protocol: "http/1.1",
    body: pendingBody(),
  };
}

describe("main redirect handling", () => {
  beforeEach(() => {
    mocks.http1Request.mockReset();
    mocks.createSocket.mockReset();
    mocks.destroy.mockReset();
    mocks.createSocket.mockResolvedValue({ destroy: mocks.destroy });
  });

  it("should preserve PUT on 302 redirects and strip sensitive cross-origin headers", async () => {
    mocks.http1Request
      .mockResolvedValueOnce(response(302, { location: "https://other.example:8443/next" }))
      .mockResolvedValueOnce(response(200));

    await request("https://example.com/start", {
      protocol: "http/1.1",
      method: "PUT",
      body: new TextEncoder().encode("payload"),
      headers: {
        authorization: "Bearer token",
        "x-api-key": "secret",
        "x-keep": "ok",
      },
    });

    expect(mocks.http1Request).toHaveBeenCalledTimes(2);
    expect(mocks.http1Request.mock.calls[1]![1].method).toBe("PUT");
    expect(mocks.http1Request.mock.calls[1]![1].headers["authorization"]).toBeUndefined();
    expect(mocks.http1Request.mock.calls[1]![1].headers["x-api-key"]).toBeUndefined();
    expect(mocks.http1Request.mock.calls[1]![1].headers["x-keep"]).toBe("ok");
    expect(mocks.http1Request.mock.calls[1]![1].headers["host"]).toBe("other.example:8443");
  });

  it("should rewrite POST to GET on 301 and close without reading the redirect body", async () => {
    const cancel = vi.fn();
    const first = response(301, { location: "https://example.com/next" });
    first.body = pendingBody(cancel);
    mocks.http1Request.mockResolvedValueOnce(first).mockResolvedValueOnce(response(200));

    await request("https://example.com/start", {
      protocol: "http/1.1",
      method: "POST",
      body: new TextEncoder().encode("payload"),
    });

    expect(mocks.http1Request.mock.calls[1]![1].method).toBe("GET");
    expect(mocks.http1Request.mock.calls[1]![1].body).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it("should preserve HEAD on 303 redirects", async () => {
    mocks.http1Request
      .mockResolvedValueOnce(response(303, { location: "https://example.com/next" }))
      .mockResolvedValueOnce(response(200));

    await request("https://example.com/start", {
      protocol: "http/1.1",
      method: "HEAD",
    });

    expect(mocks.http1Request.mock.calls[1]![1].method).toBe("HEAD");
  });
});
