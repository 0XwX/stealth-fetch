import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ipv4ToNAT64,
  isCloudflareIPv4,
  resolveIPv4,
  resolveAndCheckCloudflare,
} from "../../src/socket/nat64.js";

describe("ipv4ToNAT64", () => {
  it("should convert a valid IPv4 address with a short prefix", () => {
    const ipv4 = "108.160.165.8";
    const prefix = "2602:fc59:b0:64::";
    const result = ipv4ToNAT64(ipv4, prefix);
    expect(result).toBe("[2602:fc59:b0:64::6ca0:a508]");
  });

  it("should convert a valid IPv4 address with a full prefix", () => {
    const ipv4 = "108.160.165.8";
    const prefix = "2a00:1098:2b:0:0:1:";
    const result = ipv4ToNAT64(ipv4, prefix);
    expect(result).toBe("[2a00:1098:2b:0:0:1:6ca0:a508]");
  });

  it("should convert a valid IPv4 address with single digit octets", () => {
    const ipv4 = "1.2.3.4";
    const prefix = "prefix:";
    const result = ipv4ToNAT64(ipv4, prefix);
    expect(result).toBe("[prefix:0102:0304]");
  });

  it("should throw an error for invalid IPv4 length", () => {
    expect(() => ipv4ToNAT64("1.2.3", "prefix")).toThrow(/Invalid IPv4: 1.2.3/);
    expect(() => ipv4ToNAT64("1.2.3.4.5", "prefix")).toThrow(/Invalid IPv4: 1.2.3.4.5/);
    expect(() => ipv4ToNAT64("", "prefix")).toThrow(/Invalid IPv4:/);
  });

  it("should throw an error for IPv4 octet out of range", () => {
    expect(() => ipv4ToNAT64("256.0.0.1", "prefix")).toThrow(/Invalid IPv4 octet: 256/);
    expect(() => ipv4ToNAT64("-1.0.0.1", "prefix")).toThrow(/Invalid IPv4 octet: -1/);
  });

  it("should throw an error for non-numeric IPv4 octet", () => {
    expect(() => ipv4ToNAT64("1.2.a.4", "prefix")).toThrow(/Invalid IPv4 octet: a/);
    expect(() => ipv4ToNAT64("1.2.NaN.4", "prefix")).toThrow(/Invalid IPv4 octet: NaN/);
  });
});

describe("isCloudflareIPv4", () => {
  it("should identify Cloudflare IPv4 addresses", () => {
    expect(isCloudflareIPv4("173.245.48.1")).toBe(true);
    expect(isCloudflareIPv4("103.21.244.5")).toBe(true);
    expect(isCloudflareIPv4("104.16.0.1")).toBe(true);
    expect(isCloudflareIPv4("172.64.0.1")).toBe(true);
  });

  it("should not identify non-Cloudflare IPv4 addresses", () => {
    expect(isCloudflareIPv4("8.8.8.8")).toBe(false);
    expect(isCloudflareIPv4("192.168.1.1")).toBe(false);
  });
});

describe("DNS resolution", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolveIPv4", () => {
    it("should resolve IPv4 address", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          Answer: [{ type: 1, data: "1.2.3.4", TTL: 300 }],
        }),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const result = await resolveIPv4("example.com");
      expect(result).toEqual({ ipv4: "1.2.3.4", ttl: 300 });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("https://one.one.one.one/dns-query?name=example.com&type=A"),
        expect.objectContaining({
          headers: { Accept: "application/dns-json" },
        }),
      );
    });

    it("should return null if fetch fails", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false } as any);
      const result = await resolveIPv4("example.com");
      expect(result).toBeNull();
    });

    it("should return null if no answer", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as any);
      const result = await resolveIPv4("example.com");
      expect(result).toBeNull();
    });
  });

  describe("resolveAndCheckCloudflare", () => {
    it("should detect Cloudflare IP via A record", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          Answer: [{ type: 1, data: "104.16.0.1", TTL: 300 }],
        }),
      } as any);

      const result = await resolveAndCheckCloudflare("example.com");
      expect(result.isCf).toBe(true);
      expect(result.ipv4).toBe("104.16.0.1");
      expect(result.ttl).toBe(300);
      // Only A query, no AAAA
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("type=A"), expect.any(Object));
    });
  });
});
