import { describe, it, expect } from "vitest";
import { normalizeRetry, calculateRetryDelay } from "../../src/client.js";

// ── Unit tests for pure helper functions ──────────────────────

describe("normalizeRetry", () => {
  it("should return null for undefined", () => {
    expect(normalizeRetry(undefined)).toBeNull();
  });

  it("should return null for false", () => {
    expect(normalizeRetry(false)).toBeNull();
  });

  it("should return null for 0", () => {
    expect(normalizeRetry(0)).toBeNull();
  });

  it("should normalize a number shorthand", () => {
    const result = normalizeRetry(3);
    expect(result).not.toBeNull();
    expect(result!.limit).toBe(3);
    expect(result!.methods.has("GET")).toBe(true);
    expect(result!.methods.has("POST")).toBe(false);
    expect(result!.statusCodes.has(503)).toBe(true);
    expect(result!.baseDelay).toBe(1000);
    expect(result!.maxDelay).toBe(30_000);
  });

  it("should normalize a full options object", () => {
    const result = normalizeRetry({
      limit: 5,
      methods: ["POST", "get"],
      statusCodes: [500, 502],
      baseDelay: 500,
      maxDelay: 10_000,
    });
    expect(result).not.toBeNull();
    expect(result!.limit).toBe(5);
    expect(result!.methods.has("POST")).toBe(true);
    expect(result!.methods.has("GET")).toBe(true); // uppercased
    expect(result!.methods.has("DELETE")).toBe(false);
    expect(result!.statusCodes.has(500)).toBe(true);
    expect(result!.statusCodes.has(503)).toBe(false);
    expect(result!.baseDelay).toBe(500);
    expect(result!.maxDelay).toBe(10_000);
  });

  it("should use defaults for partial options", () => {
    const result = normalizeRetry({ limit: 1 });
    expect(result).not.toBeNull();
    expect(result!.methods.has("GET")).toBe(true);
    expect(result!.statusCodes.has(429)).toBe(true);
    expect(result!.baseDelay).toBe(1000);
    expect(result!.maxDelay).toBe(30_000);
  });

  it("should include all default retryable methods", () => {
    const result = normalizeRetry(1);
    expect(result).not.toBeNull();
    for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]) {
      expect(result!.methods.has(method)).toBe(true);
    }
    // POST and PATCH are NOT in defaults
    expect(result!.methods.has("POST")).toBe(false);
    expect(result!.methods.has("PATCH")).toBe(false);
  });

  it("should include all default retryable status codes", () => {
    const result = normalizeRetry(1);
    expect(result).not.toBeNull();
    for (const code of [408, 413, 429, 500, 502, 503, 504]) {
      expect(result!.statusCodes.has(code)).toBe(true);
    }
    // 404 is NOT retryable by default
    expect(result!.statusCodes.has(404)).toBe(false);
  });
});

describe("calculateRetryDelay", () => {
  it("should use exponential backoff when no Retry-After header", () => {
    const config = { baseDelay: 1000, maxDelay: 30_000 };
    expect(calculateRetryDelay(undefined, 0, config)).toBe(1000); // 1000 * 2^0
    expect(calculateRetryDelay(undefined, 1, config)).toBe(2000); // 1000 * 2^1
    expect(calculateRetryDelay(undefined, 2, config)).toBe(4000); // 1000 * 2^2
    expect(calculateRetryDelay(undefined, 3, config)).toBe(8000); // 1000 * 2^3
  });

  it("should respect maxDelay", () => {
    const config = { baseDelay: 10_000, maxDelay: 5000 };
    expect(calculateRetryDelay(undefined, 0, config)).toBe(5000); // clamped
    expect(calculateRetryDelay(undefined, 1, config)).toBe(5000); // clamped
  });

  it("should parse Retry-After as seconds", () => {
    const config = { baseDelay: 1000, maxDelay: 30_000 };
    expect(calculateRetryDelay("2", 0, config)).toBe(2000);
    expect(calculateRetryDelay("10", 0, config)).toBe(10_000);
  });

  it("should clamp Retry-After seconds to maxDelay", () => {
    const config = { baseDelay: 1000, maxDelay: 5000 };
    expect(calculateRetryDelay("120", 0, config)).toBe(5000);
  });

  it("should parse Retry-After as HTTP-date", () => {
    const config = { baseDelay: 1000, maxDelay: 30_000 };
    // Use a large enough offset to avoid flakiness from execution time
    const futureDate = new Date(Date.now() + 5000).toUTCString();
    const delay = calculateRetryDelay(futureDate, 0, config);
    // Should be approximately 5000ms (allow generous tolerance for test execution)
    expect(delay).toBeGreaterThan(4000);
    expect(delay).toBeLessThanOrEqual(5500);
  });

  it("should fall back to exponential backoff for invalid Retry-After", () => {
    const config = { baseDelay: 1000, maxDelay: 30_000 };
    expect(calculateRetryDelay("invalid", 1, config)).toBe(2000);
  });

  it("should fall back to exponential backoff for past Retry-After date", () => {
    const config = { baseDelay: 1000, maxDelay: 30_000 };
    const pastDate = new Date(Date.now() - 5000).toUTCString();
    expect(calculateRetryDelay(pastDate, 0, config)).toBe(1000);
  });

  it("should handle Retry-After: 0 by falling back to exponential backoff", () => {
    const config = { baseDelay: 1000, maxDelay: 30_000 };
    // "0" seconds is not > 0, so falls back to exponential
    expect(calculateRetryDelay("0", 0, config)).toBe(1000);
  });
});
