import { describe, it, expect } from "vitest";
import { request } from "../../src/index.js";

describe("Request Timeout", () => {
  it("should throw TimeoutError for very short timeout", async () => {
    // Use an extremely short timeout (1ms) against a real host
    // This should reliably fail before a TLS handshake can complete
    await expect(request("https://httpbin.org/delay/5", { timeout: 1 })).rejects.toThrow(
      /timed out/i,
    );
  });

  it("should throw TimeoutError with custom timeout value in message", async () => {
    try {
      await request("https://httpbin.org/delay/5", { timeout: 50 });
      // Should not reach here
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("TimeoutError");
      expect((err as DOMException).message).toContain("50ms");
    }
  });

  it("should respect user-provided AbortSignal", async () => {
    const controller = new AbortController();
    // Abort immediately
    controller.abort(new DOMException("User cancelled", "AbortError"));

    await expect(
      request("https://httpbin.org/headers", { signal: controller.signal }),
    ).rejects.toThrow("User cancelled");
  });

  it("should throw immediately if signal is already aborted before request", async () => {
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    await expect(
      request("https://httpbin.org/headers", { signal: controller.signal }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;

    // Should reject nearly instantly (< 100ms), not after timeout
    expect(elapsed).toBeLessThan(100);
  });

  it("should succeed with a generous timeout", async () => {
    // This test verifies that timeout does NOT interfere when it's long enough
    // Use the integration test's known-working httpbin endpoint
    const response = await request("https://httpbin.org/headers", {
      timeout: 15000,
      protocol: "http/1.1",
      headers: { "User-Agent": "timeout-test/1.0" },
    });

    expect(response.status).toBe(200);
    expect(response.protocol).toBe("http/1.1");
    const text = await response.text();
    expect(text).toContain("User-Agent");
  });
});
