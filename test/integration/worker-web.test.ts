import { describe, it, expect } from "vitest";

/**
 * Integration tests for stealth-fetch/web.
 * Verifies the web entry can be imported and exports all expected APIs.
 */
describe("stealth-fetch/web Integration", () => {
  it("should import request function", async () => {
    const { request } = await import("../../src/web/index.js");
    expect(request).toBeDefined();
    expect(typeof request).toBe("function");
  });

  it("should export all public APIs", async () => {
    const mod = await import("../../src/web/index.js");

    expect(mod.request).toBeDefined();
    expect(mod.prewarmDns).toBeDefined();
    expect(mod.toWebResponse).toBeDefined();
    expect(mod.clearDnsCache).toBeDefined();
    expect(mod.clearNat64PrefixStats).toBeDefined();
    expect(mod.parseUrl).toBeDefined();

    expect(typeof mod.request).toBe("function");
    expect(typeof mod.prewarmDns).toBe("function");
    expect(typeof mod.toWebResponse).toBe("function");
    expect(typeof mod.clearDnsCache).toBe("function");
    expect(typeof mod.clearNat64PrefixStats).toBe("function");
    expect(typeof mod.parseUrl).toBe("function");
  });

  it("should parse URLs correctly", async () => {
    const { parseUrl } = await import("../../src/web/index.js");

    const parsed = parseUrl("https://api.openai.com/v1/chat/completions?model=gpt-4");
    expect(parsed.protocol).toBe("https");
    expect(parsed.hostname).toBe("api.openai.com");
    expect(parsed.port).toBe(443);
    expect(parsed.path).toBe("/v1/chat/completions?model=gpt-4");
  });
});
