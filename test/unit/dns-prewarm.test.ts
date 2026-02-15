import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prewarmDns } from "../../src/client.js";
import { clearDnsCache } from "../../src/dns-cache.js";

vi.mock("../../src/socket/tls.js", () => ({
  createSocket: vi.fn(),
  createWasmTLSSocket: vi.fn(),
}));

vi.mock("../../src/socket/wasm-tls-bridge.js", () => ({
  preloadWasmTls: vi.fn(),
}));

function dnsJsonResponse(answer: Array<{ type: number; data: string; TTL: number }>) {
  return {
    ok: true,
    json: async () => ({ Answer: answer }),
  };
}

describe("prewarmDns", () => {
  beforeEach(() => {
    clearDnsCache();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    clearDnsCache();
    vi.restoreAllMocks();
  });

  it("should dedupe hostnames before warming", async () => {
    vi.mocked(fetch).mockResolvedValue(
      dnsJsonResponse([{ type: 1, data: "104.16.0.1", TTL: 300 }]) as Response,
    );

    await prewarmDns(["Example.com", "example.com", "foo.com"], { concurrency: 8 });

    // 2 unique hosts * 1 A query each
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("should use singleflight across concurrent warmups for same host", async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return dnsJsonResponse([{ type: 1, data: "104.16.0.1", TTL: 120 }]) as Response;
    });

    await Promise.all([
      prewarmDns(["singleflight.example"], { concurrency: 1 }),
      prewarmDns(["SINGLEFLIGHT.example"], { concurrency: 1 }),
    ]);

    // single lookup for one hostname => 1 A query only once
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("should throw when cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(
      prewarmDns(["cancel.example"], {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled|Abort/);
  });
});
