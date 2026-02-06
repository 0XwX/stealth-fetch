import { describe, it, expect } from "vitest";
import { preloadHpack } from "../../../src/http2/hpack.js";

/**
 * HPACK encode/decode tests are skipped in this environment because hpack.js
 * depends on `readable-stream` which crashes during module initialization in
 * the CF Workers Vitest pool (Buffer.prototype.slice undefined).
 *
 * HPACK correctness is verified via integration tests (worker.test.ts)
 * and the live /http2, /h2-* endpoints which exercise full encode/decode.
 */
describe("HPACK", () => {
  describe("preloadHpack", () => {
    it("should not throw when called", () => {
      expect(() => preloadHpack()).not.toThrow();
    });

    it("should be idempotent", () => {
      preloadHpack();
      preloadHpack();
    });
  });
});
