import { describe, it, expect } from "vitest";

/**
 * Live request tests for stealth-fetch/lite.
 * Validates that the lite entry can make real HTTP/1.1 requests
 * via cloudflare:sockets + platform TLS (no WASM, no DoH).
 */
describe("stealth-fetch/lite — live request", () => {
  it("should make HTTP/1.1 GET request via platform TLS", async () => {
    const { request } = await import("../../src/lite/index.js");

    const response = await request("https://httpbin.org/headers", { timeout: 15000 });
    expect(response.status).toBe(200);

    const body = await response.text();
    const json = JSON.parse(body);
    expect(json.headers).toBeDefined();

    // lite uses cloudflare:sockets → no cf-* header injection
    expect(json.headers["Cf-Connecting-Ip"]).toBeUndefined();
  });

  it("should handle POST with JSON body", async () => {
    const { request } = await import("../../src/lite/index.js");

    const response = await request("https://httpbin.org/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: "lite" }),
      timeout: 15000,
    });
    expect(response.status).toBe(200);

    const body = await response.text();
    const json = JSON.parse(body);
    expect(json.json).toEqual({ test: "lite" });
  });

  it("should follow redirects", async () => {
    const { request } = await import("../../src/lite/index.js");

    const response = await request("https://httpbin.org/redirect/1", { timeout: 15000 });
    expect(response.status).toBe(200);
  });

  it("should respect timeout", async () => {
    const { request } = await import("../../src/lite/index.js");

    await expect(request("https://httpbin.org/delay/10", { timeout: 100 })).rejects.toThrow(
      /timed out/i,
    );
  });
});
