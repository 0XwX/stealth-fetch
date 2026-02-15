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
    vi.mocked(fetch).mockImplementation(async input => {
      const url = input.toString();
      if (url.includes("type=AAAA")) {
        return dnsJsonResponse([{ type: 28, data: "2606:4700::1", TTL: 300 }]) as Response;
      }
      return dnsJsonResponse([{ type: 1, data: "104.16.0.1", TTL: 300 }]) as Response;
    });

    await prewarmDns(["Example.com", "example.com", "foo.com"], { concurrency: 8 });

    // 2 unique hosts * (A + AAAA)
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("should use singleflight across concurrent warmups for same host", async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const url = input.toString();
      await new Promise(resolve => setTimeout(resolve, 15));
      if (url.includes("type=AAAA")) {
        return dnsJsonResponse([{ type: 28, data: "2606:4700::1", TTL: 120 }]) as Response;
      }
      return dnsJsonResponse([{ type: 1, data: "104.16.0.1", TTL: 120 }]) as Response;
    });

    await Promise.all([
      prewarmDns(["singleflight.example"], { concurrency: 1 }),
      prewarmDns(["SINGLEFLIGHT.example"], { concurrency: 1 }),
    ]);

    // single lookup for one hostname => A + AAAA only once
    expect(fetch).toHaveBeenCalledTimes(2);
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
