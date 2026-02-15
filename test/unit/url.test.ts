import { describe, it, expect } from "vitest";
import { parseUrl } from "../../src/utils/url.js";

describe("parseUrl", () => {
  it("should parse standard HTTP URL with default port", () => {
    const url = "http://example.com/path";
    const result = parseUrl(url);
    expect(result).toEqual({
      protocol: "http",
      hostname: "example.com",
      port: 80,
      path: "/path",
    });
  });

  it("should parse standard HTTPS URL with default port", () => {
    const url = "https://example.com/path";
    const result = parseUrl(url);
    expect(result).toEqual({
      protocol: "https",
      hostname: "example.com",
      port: 443,
      path: "/path",
    });
  });

  it("should parse HTTP URL with explicit port", () => {
    const url = "http://example.com:8080/path";
    const result = parseUrl(url);
    expect(result).toEqual({
      protocol: "http",
      hostname: "example.com",
      port: 8080,
      path: "/path",
    });
  });

  it("should parse HTTPS URL with explicit port", () => {
    const url = "https://example.com:8443/path";
    const result = parseUrl(url);
    expect(result).toEqual({
      protocol: "https",
      hostname: "example.com",
      port: 8443,
      path: "/path",
    });
  });

  it("should parse URL with query parameters", () => {
    const url = "http://example.com/path?query=1&foo=bar";
    const result = parseUrl(url);
    expect(result).toEqual({
      protocol: "http",
      hostname: "example.com",
      port: 80,
      path: "/path?query=1&foo=bar",
    });
  });

  it("should parse URL with no path (default to /)", () => {
    const url = "http://example.com";
    const result = parseUrl(url);
    expect(result).toEqual({
      protocol: "http",
      hostname: "example.com",
      port: 80,
      path: "/",
    });
  });

  it("should parse URL with root path", () => {
    const url = "http://example.com/";
    const result = parseUrl(url);
    expect(result).toEqual({
      protocol: "http",
      hostname: "example.com",
      port: 80,
      path: "/",
    });
  });

  it("should parse IPv4 address", () => {
    const url = "http://127.0.0.1:3000";
    const result = parseUrl(url);
    expect(result).toEqual({
      protocol: "http",
      hostname: "127.0.0.1",
      port: 3000,
      path: "/",
    });
  });

  it("should parse IPv6 address", () => {
    const url = "http://[::1]:3000";
    const result = parseUrl(url);
    expect(result).toEqual({
      protocol: "http",
      hostname: "[::1]",
      port: 3000,
      path: "/",
    });
  });

  it("should include query string but not fragment in path", () => {
    // Note: The implementation of parseUrl takes parsed.pathname + parsed.search.
    // Fragments are not sent to the server, so they should typically be ignored or not present in the 'path' used for requests.
    // Let's see how the implementation handles fragments.
    // const path = parsed.pathname + parsed.search;
    // URL.hash is separate. So it won't be included.
    const url = "https://example.com/path?query=1#fragment";
    const result = parseUrl(url);
    expect(result).toEqual({
      protocol: "https",
      hostname: "example.com",
      port: 443,
      path: "/path?query=1",
    });
  });

  it("should throw on invalid URL", () => {
     expect(() => parseUrl("not-a-url")).toThrow(TypeError);
  });
});
