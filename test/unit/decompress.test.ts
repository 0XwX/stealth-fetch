import { describe, it, expect } from "vitest";

/**
 * Test the decompressResponse logic by directly testing the pattern:
 * ReadableStream.pipeThrough(new DecompressionStream("gzip"|"deflate"))
 *
 * Since decompressResponse is a private function in client.ts, we test
 * the underlying mechanism used by CF Workers runtime.
 */
describe("DecompressionStream", () => {
  async function compress(data: Uint8Array, format: "gzip" | "deflate"): Promise<Uint8Array> {
    const cs = new CompressionStream(format);
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();

    const reader = cs.readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    return result;
  }

  async function decompress(data: Uint8Array, format: "gzip" | "deflate"): Promise<Uint8Array> {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();

    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    return result;
  }

  it("should round-trip gzip compression", async () => {
    const original = new TextEncoder().encode("Hello, gzip world!");
    const compressed = await compress(original, "gzip");
    expect(compressed.length).toBeGreaterThan(0);
    expect(compressed.length).not.toBe(original.length);

    const decompressed = await decompress(compressed, "gzip");
    expect(new TextDecoder().decode(decompressed)).toBe("Hello, gzip world!");
  });

  it("should round-trip deflate compression", async () => {
    const original = new TextEncoder().encode("Hello, deflate world!");
    const compressed = await compress(original, "deflate");
    const decompressed = await decompress(compressed, "deflate");
    expect(new TextDecoder().decode(decompressed)).toBe("Hello, deflate world!");
  });

  it("should handle pipeThrough pattern (matching client.ts decompressResponse)", async () => {
    const original = new TextEncoder().encode('{"model":"gpt-4","choices":[]}');
    const compressed = await compress(original, "gzip");

    // Simulate what decompressResponse does: body.pipeThrough(new DecompressionStream(...))
    const compressedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(compressed);
        controller.close();
      },
    });

    const decompressedStream = compressedStream.pipeThrough(new DecompressionStream("gzip"));
    const reader = decompressedStream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    expect(new TextDecoder().decode(result)).toBe('{"model":"gpt-4","choices":[]}');
  });

  it("should round-trip request body compression (gzip)", async () => {
    // Simulate what compressRequestBody does: gzip compress a large body
    const payload = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2000) }] });
    const original = new TextEncoder().encode(payload);
    expect(original.length).toBeGreaterThan(1024); // over threshold

    const compressed = await compress(original, "gzip");
    expect(compressed.length).toBeLessThan(original.length); // gzip should shrink repeated data

    // Server-side decompression should recover original
    const decompressed = await decompress(compressed, "gzip");
    expect(new TextDecoder().decode(decompressed)).toBe(payload);
  });

  it("should handle large data", async () => {
    // ~20KB repeated JSON, simulating API response
    const text = JSON.stringify({ data: "x".repeat(20000) });
    const original = new TextEncoder().encode(text);
    const compressed = await compress(original, "gzip");

    // gzip should achieve significant compression on repeated data
    expect(compressed.length).toBeLessThan(original.length / 2);

    const decompressed = await decompress(compressed, "gzip");
    expect(new TextDecoder().decode(decompressed)).toBe(text);
  });
});
