import { describe, it, expect } from "vitest";

describe("stealth-fetch/lite exports", () => {
  it("should export request function", async () => {
    const { request } = await import("../../../src/lite/index.js");
    expect(request).toBeDefined();
    expect(typeof request).toBe("function");
  });

  it("should export all public APIs", async () => {
    const mod = await import("../../../src/lite/index.js");

    expect(mod.request).toBeDefined();
    expect(mod.toWebResponse).toBeDefined();
    expect(mod.parseUrl).toBeDefined();

    expect(typeof mod.request).toBe("function");
    expect(typeof mod.toWebResponse).toBe("function");
    expect(typeof mod.parseUrl).toBe("function");
  });

  it("should NOT export DoH/NAT64 functions (lite has no DoH)", async () => {
    const mod = await import("../../../src/lite/index.js");

    expect(mod).not.toHaveProperty("prewarmDns");
    expect(mod).not.toHaveProperty("clearDnsCache");
    expect(mod).not.toHaveProperty("clearNat64PrefixStats");
  });

  it("should parse URLs correctly", async () => {
    const { parseUrl } = await import("../../../src/lite/index.js");

    const parsed = parseUrl("https://api.example.com/v1/data?key=value");
    expect(parsed.protocol).toBe("https");
    expect(parsed.hostname).toBe("api.example.com");
    expect(parsed.port).toBe(443);
    expect(parsed.path).toBe("/v1/data?key=value");
  });
});
