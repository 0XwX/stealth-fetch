import { describe, it, expect } from "vitest";

/**
 * Integration smoke test for stealth-fetch/lite.
 * Imports by PACKAGE NAME (not relative path) to validate
 * the package.json exports field resolves correctly.
 */
describe("stealth-fetch/lite Integration", () => {
  it("should import via package name 'stealth-fetch/lite'", async () => {
    const mod = await import("stealth-fetch/lite");

    expect(mod.request).toBeDefined();
    expect(typeof mod.request).toBe("function");
  });

  it("should export all public APIs via package name", async () => {
    const mod = await import("stealth-fetch/lite");

    expect(mod.request).toBeDefined();
    expect(mod.toWebResponse).toBeDefined();
    expect(mod.parseUrl).toBeDefined();

    expect(typeof mod.request).toBe("function");
    expect(typeof mod.toWebResponse).toBe("function");
    expect(typeof mod.parseUrl).toBe("function");
  });

  it("should NOT export DoH/NAT64 functions via package name", async () => {
    const mod = await import("stealth-fetch/lite");

    expect(mod).not.toHaveProperty("prewarmDns");
    expect(mod).not.toHaveProperty("clearDnsCache");
    expect(mod).not.toHaveProperty("clearNat64PrefixStats");
    expect(mod).not.toHaveProperty("createFullStrategy");
  });

  it("should parse URLs correctly via package name", async () => {
    const { parseUrl } = await import("stealth-fetch/lite");

    const parsed = parseUrl("https://api.example.com/v1/data?key=value");
    expect(parsed.protocol).toBe("https");
    expect(parsed.hostname).toBe("api.example.com");
    expect(parsed.port).toBe(443);
    expect(parsed.path).toBe("/v1/data?key=value");
  });
});
