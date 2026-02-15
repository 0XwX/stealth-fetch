import { describe, it, expect } from "vitest";
import { ChunkedDecoder } from "../../../../src/web/http1/chunked.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("ChunkedDecoder (web/Uint8Array)", () => {
  it("should decode a single chunk", () => {
    const decoder = new ChunkedDecoder();
    decoder.feed(enc.encode("5\r\nhello\r\n0\r\n\r\n"));

    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(1);
    expect(dec.decode(chunks[0])).toBe("hello");
    expect(decoder.done).toBe(true);
  });

  it("should decode multiple chunks", () => {
    const decoder = new ChunkedDecoder();
    decoder.feed(enc.encode("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"));

    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(2);
    expect(dec.decode(chunks[0])).toBe("hello");
    expect(dec.decode(chunks[1])).toBe(" world");
    expect(decoder.done).toBe(true);
  });

  it("should handle data arriving in fragments", () => {
    const decoder = new ChunkedDecoder();

    decoder.feed(enc.encode("5\r\nhel"));
    expect(decoder.getChunks().length).toBe(0);
    expect(decoder.done).toBe(false);

    decoder.feed(enc.encode("lo\r\n0\r\n\r\n"));
    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(1);
    expect(dec.decode(chunks[0])).toBe("hello");
    expect(decoder.done).toBe(true);
  });

  it("should handle size line split across fragments", () => {
    const decoder = new ChunkedDecoder();

    decoder.feed(enc.encode("5"));
    expect(decoder.getChunks().length).toBe(0);

    decoder.feed(enc.encode("\r\nhello\r\n0\r\n\r\n"));
    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(1);
    expect(dec.decode(chunks[0])).toBe("hello");
    expect(decoder.done).toBe(true);
  });

  it("should handle hex size with uppercase", () => {
    const decoder = new ChunkedDecoder();
    decoder.feed(enc.encode("A\r\n0123456789\r\n0\r\n\r\n"));

    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(1);
    expect(dec.decode(chunks[0])).toBe("0123456789");
    expect(decoder.done).toBe(true);
  });

  it("should handle chunk extensions (ignore them)", () => {
    const decoder = new ChunkedDecoder();
    decoder.feed(enc.encode("5;ext=val\r\nhello\r\n0\r\n\r\n"));

    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(1);
    expect(dec.decode(chunks[0])).toBe("hello");
    expect(decoder.done).toBe(true);
  });

  it("should handle empty body (zero chunk only)", () => {
    const decoder = new ChunkedDecoder();
    decoder.feed(enc.encode("0\r\n\r\n"));

    expect(decoder.getChunks().length).toBe(0);
    expect(decoder.done).toBe(true);
  });
});
