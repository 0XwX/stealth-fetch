import { describe, it, expect } from "vitest";
import { serializeHttp1Headers } from "../../src/utils/headers.js";

describe("Header Security Validation (CR/LF/NUL)", () => {
  describe("serializeHttp1Headers", () => {
    it("should serialize valid headers correctly", () => {
      const result = serializeHttp1Headers({
        "Content-Type": "application/json",
        "X-Custom": "hello",
      });
      expect(result).toBe("Content-Type: application/json\r\nX-Custom: hello\r\n");
    });

    it("should reject header name containing CR (\\r)", () => {
      expect(() => serializeHttp1Headers({ "Bad\rName": "value" })).toThrow(/Invalid header name/);
    });

    it("should reject header name containing LF (\\n)", () => {
      expect(() => serializeHttp1Headers({ "Bad\nName": "value" })).toThrow(/Invalid header name/);
    });

    it("should reject header name containing NUL (\\0)", () => {
      expect(() => serializeHttp1Headers({ "Bad\0Name": "value" })).toThrow(/Invalid header name/);
    });

    it("should reject header value containing CR (\\r)", () => {
      expect(() => serializeHttp1Headers({ "X-Inject": "value\rEvil: injected" })).toThrow(
        /Invalid header.*CR\/LF\/NUL/,
      );
    });

    it("should reject header value containing LF (\\n)", () => {
      expect(() => serializeHttp1Headers({ "X-Inject": "value\nEvil: injected" })).toThrow(
        /Invalid header.*CR\/LF\/NUL/,
      );
    });

    it("should reject header value containing NUL (\\0)", () => {
      expect(() => serializeHttp1Headers({ "X-Inject": "value\0hidden" })).toThrow(
        /Invalid header.*CR\/LF\/NUL/,
      );
    });

    it("should reject CRLF injection attempt in value", () => {
      expect(() => serializeHttp1Headers({ "X-Inject": "ok\r\nEvil-Header: pwned" })).toThrow(
        /Invalid header.*CR\/LF\/NUL/,
      );
    });

    it("should handle empty headers object", () => {
      expect(serializeHttp1Headers({})).toBe("");
    });

    it("should allow headers with special but safe characters", () => {
      const result = serializeHttp1Headers({
        "X-Emoji": "hello 🌍",
        "X-Utf8": "日本語",
        "X-Special": "value-with.dots_and/slashes",
      });
      expect(result).toContain("X-Emoji: hello 🌍\r\n");
      expect(result).toContain("X-Utf8: 日本語\r\n");
    });
  });
});
