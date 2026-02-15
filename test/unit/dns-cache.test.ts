import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCachedDns, setCachedDns, clearDnsCache } from "../../src/dns-cache.js";

describe("dns-cache", () => {
  beforeEach(() => {
    clearDnsCache();
  });
  it("should return null for uncached hostname", () => {
    expect(getCachedDns("uncached.dns.test")).toBeNull();
  });

  it("should cache and retrieve DNS result", () => {
    setCachedDns("cached.dns.test", {
      isCf: true,
      ipv4: "104.16.0.1",
      dnsMs: 5,
      ttl: 300,
    });
    const result = getCachedDns("cached.dns.test");
    expect(result).not.toBeNull();
    expect(result!.isCf).toBe(true);
    expect(result!.ipv4).toBe("104.16.0.1");
    expect(result!.dnsMs).toBe(0); // cached hit returns 0
  });

  it("should expire entries after TTL", () => {
    vi.useFakeTimers();
    try {
      setCachedDns("ttl.dns.test", {
        isCf: false,
        ipv4: "1.2.3.4",
        dnsMs: 3,
        ttl: 60, // 60s → clamped to MIN_TTL 30s
      });
      expect(getCachedDns("ttl.dns.test")).not.toBeNull();

      // Advance past max possible TTL (5 min + 1ms)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(getCachedDns("ttl.dns.test")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should clamp TTL to minimum 30s", () => {
    vi.useFakeTimers();
    try {
      setCachedDns("min-ttl.dns.test", {
        isCf: false,
        ipv4: "1.2.3.4",
        dnsMs: 2,
        ttl: 1, // 1s → clamped to 30s
      });

      // At 29s, still cached
      vi.advanceTimersByTime(29_000);
      expect(getCachedDns("min-ttl.dns.test")).not.toBeNull();

      // At 31s, expired
      vi.advanceTimersByTime(2_000);
      expect(getCachedDns("min-ttl.dns.test")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should clamp TTL to maximum 5min", () => {
    vi.useFakeTimers();
    try {
      setCachedDns("max-ttl.dns.test", {
        isCf: false,
        ipv4: "1.2.3.4",
        dnsMs: 2,
        ttl: 86400, // 1 day → clamped to 5min
      });

      // At 4min 59s, still cached
      vi.advanceTimersByTime(4 * 60 * 1000 + 59_000);
      expect(getCachedDns("max-ttl.dns.test")).not.toBeNull();

      // At 5min + 1s, expired
      vi.advanceTimersByTime(2_000);
      expect(getCachedDns("max-ttl.dns.test")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should evict oldest entry when at capacity (500)", () => {
    for (let i = 0; i < 500; i++) {
      setCachedDns(`evict-${i}.dns.test`, {
        isCf: false,
        ipv4: "1.2.3.4",
        dnsMs: 1,
        ttl: 300,
      });
    }
    // Add one more — first entry should be evicted
    setCachedDns("evict-new.dns.test", {
      isCf: true,
      ipv4: "104.16.0.1",
      dnsMs: 1,
      ttl: 300,
    });
    expect(getCachedDns("evict-new.dns.test")).not.toBeNull();
    expect(getCachedDns("evict-0.dns.test")).toBeNull();
  });

  it("should clear all entries", () => {
    setCachedDns("clear.dns.test", {
      isCf: false,
      ipv4: "1.2.3.4",
      dnsMs: 1,
      ttl: 300,
    });
    expect(getCachedDns("clear.dns.test")).not.toBeNull();
    clearDnsCache();
    expect(getCachedDns("clear.dns.test")).toBeNull();
  });

  it("should cache DoH failure with 10s short TTL (ttl=0)", () => {
    vi.useFakeTimers();
    try {
      // ttl=0 indicates DoH failure degradation
      setCachedDns("doh-fail.dns.test", {
        isCf: false,
        ipv4: null,
        dnsMs: 0,
        ttl: 0,
      });

      // Immediately available
      expect(getCachedDns("doh-fail.dns.test")).not.toBeNull();
      expect(getCachedDns("doh-fail.dns.test")!.isCf).toBe(false);
      expect(getCachedDns("doh-fail.dns.test")!.ipv4).toBeNull();

      // At 9s, still cached
      vi.advanceTimersByTime(9_000);
      expect(getCachedDns("doh-fail.dns.test")).not.toBeNull();

      // At 11s, expired (10s negative TTL)
      vi.advanceTimersByTime(2_000);
      expect(getCachedDns("doh-fail.dns.test")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should return remaining ttl in cached result", () => {
    vi.useFakeTimers();
    try {
      setCachedDns("ttl-remaining.dns.test", {
        isCf: false,
        ipv4: "1.2.3.4",
        dnsMs: 5,
        ttl: 120,
      });
      vi.advanceTimersByTime(30_000);
      const result = getCachedDns("ttl-remaining.dns.test");
      expect(result).not.toBeNull();
      expect(result!.ttl).toBeLessThanOrEqual(90);
      expect(result!.ttl).toBeGreaterThanOrEqual(89);
    } finally {
      vi.useRealTimers();
    }
  });
});
