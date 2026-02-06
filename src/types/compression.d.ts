/**
 * DecompressionStream type declarations for Cloudflare Workers runtime.
 * CF Workers supports gzip, deflate, and deflate-raw natively.
 * TypeScript ES2022 lib does not include these types.
 */

declare class DecompressionStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(format: "gzip" | "deflate" | "deflate-raw");
}

declare class CompressionStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(format: "gzip" | "deflate" | "deflate-raw");
}
