import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { ChunkedDecoder } from "../../../src/http1/chunked.js";

describe("ChunkedDecoder", () => {
  it("should decode a single chunk", () => {
    const decoder = new ChunkedDecoder();
    decoder.feed(Buffer.from("5\r\nhello\r\n0\r\n\r\n"));

    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(1);
    expect(chunks[0].toString()).toBe("hello");
    expect(decoder.done).toBe(true);
  });

  it("should decode multiple chunks", () => {
    const decoder = new ChunkedDecoder();
    decoder.feed(Buffer.from("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"));

    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(2);
    expect(chunks[0].toString()).toBe("hello");
    expect(chunks[1].toString()).toBe(" world");
    expect(decoder.done).toBe(true);
  });

  it("should handle data arriving in fragments", () => {
    const decoder = new ChunkedDecoder();

    decoder.feed(Buffer.from("5\r\nhel"));
    expect(decoder.getChunks().length).toBe(0);
    expect(decoder.done).toBe(false);

    decoder.feed(Buffer.from("lo\r\n0\r\n\r\n"));
    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(1);
    expect(chunks[0].toString()).toBe("hello");
    expect(decoder.done).toBe(true);
  });

  it("should handle size line split across fragments", () => {
    const decoder = new ChunkedDecoder();

    decoder.feed(Buffer.from("5"));
    expect(decoder.getChunks().length).toBe(0);

    decoder.feed(Buffer.from("\r\nhello\r\n0\r\n\r\n"));
    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(1);
    expect(chunks[0].toString()).toBe("hello");
    expect(decoder.done).toBe(true);
  });

  it("should handle hex size with uppercase", () => {
    const decoder = new ChunkedDecoder();
    decoder.feed(Buffer.from("A\r\n0123456789\r\n0\r\n\r\n"));

    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(1);
    expect(chunks[0].toString()).toBe("0123456789");
    expect(decoder.done).toBe(true);
  });

  it("should handle chunk extensions (ignore them)", () => {
    const decoder = new ChunkedDecoder();
    decoder.feed(Buffer.from("5;ext=val\r\nhello\r\n0\r\n\r\n"));

    const chunks = decoder.getChunks();
    expect(chunks.length).toBe(1);
    expect(chunks[0].toString()).toBe("hello");
    expect(decoder.done).toBe(true);
  });

  it("should handle empty body (zero chunk only)", () => {
    const decoder = new ChunkedDecoder();
    decoder.feed(Buffer.from("0\r\n\r\n"));

    expect(decoder.getChunks().length).toBe(0);
    expect(decoder.done).toBe(true);
  });
});
