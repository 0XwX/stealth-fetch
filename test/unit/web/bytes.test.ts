import { describe, it, expect } from "vitest";
import { concatBytes, encode, decode, indexOf, indexOfCRLF } from "../../../src/web/bytes.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("concatBytes", () => {
  it("should return empty Uint8Array for empty array", () => {
    const result = concatBytes([]);
    expect(result.byteLength).toBe(0);
  });

  it("should return the same array for single element", () => {
    const input = enc.encode("hello");
    const result = concatBytes([input]);
    expect(result).toBe(input);
  });

  it("should concatenate multiple arrays", () => {
    const a = enc.encode("hello");
    const b = enc.encode(" ");
    const c = enc.encode("world");
    const result = concatBytes([a, b, c]);
    expect(dec.decode(result)).toBe("hello world");
    expect(result.byteLength).toBe(11);
  });
});

describe("encode", () => {
  it("should encode a string to UTF-8 Uint8Array", () => {
    const result = encode("hello");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(dec.decode(result)).toBe("hello");
  });

  it("should return empty array for empty string", () => {
    const result = encode("");
    expect(result.byteLength).toBe(0);
  });

  it("should handle multi-byte UTF-8 characters", () => {
    const result = encode("你好");
    expect(result.byteLength).toBe(6); // 2 chars × 3 bytes each
    expect(dec.decode(result)).toBe("你好");
  });
});

describe("decode", () => {
  it("should decode UTF-8 by default", () => {
    const data = enc.encode("hello");
    expect(decode(data)).toBe("hello");
  });

  it("should decode latin1", () => {
    // Latin1 byte 0xE9 = é
    const data = new Uint8Array([0xe9]);
    expect(decode(data, "latin1")).toBe("é");
  });

  it("should handle empty data", () => {
    expect(decode(new Uint8Array(0))).toBe("");
    expect(decode(new Uint8Array(0), "latin1")).toBe("");
  });

  it("should decode high bytes in latin1 mode", () => {
    const data = new Uint8Array([0x80, 0xff]);
    const result = decode(data, "latin1");
    expect(result.length).toBe(2);
  });
});

describe("indexOf", () => {
  it("should find a sub-array", () => {
    const haystack = enc.encode("hello world");
    const needle = enc.encode("world");
    expect(indexOf(haystack, needle)).toBe(6);
  });

  it("should return -1 when not found", () => {
    const haystack = enc.encode("hello");
    const needle = enc.encode("xyz");
    expect(indexOf(haystack, needle)).toBe(-1);
  });

  it("should find at position 0", () => {
    const haystack = enc.encode("hello");
    const needle = enc.encode("hel");
    expect(indexOf(haystack, needle)).toBe(0);
  });

  it("should handle empty needle", () => {
    const haystack = enc.encode("hello");
    const needle = new Uint8Array(0);
    expect(indexOf(haystack, needle)).toBe(0);
  });

  it("should find binary patterns", () => {
    const haystack = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a, 0x01]);
    const needle = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
    expect(indexOf(haystack, needle)).toBe(0);
  });
});

describe("indexOfCRLF", () => {
  it("should find CRLF", () => {
    const data = enc.encode("hello\r\nworld");
    expect(indexOfCRLF(data)).toBe(5);
  });

  it("should return -1 when no CRLF", () => {
    const data = enc.encode("hello world");
    expect(indexOfCRLF(data)).toBe(-1);
  });

  it("should respect start offset", () => {
    const data = enc.encode("a\r\nb\r\nc");
    expect(indexOfCRLF(data, 0)).toBe(1);
    expect(indexOfCRLF(data, 3)).toBe(4);
  });

  it("should not find lone CR or LF", () => {
    const data = enc.encode("hello\rworld\n");
    expect(indexOfCRLF(data)).toBe(-1);
  });
});
