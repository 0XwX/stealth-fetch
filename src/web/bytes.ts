/**
 * Uint8Array utilities — replaces node:buffer (Buffer) for the web entry.
 * All functions work with standard Uint8Array, no Node.js dependencies.
 */

const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
const latin1Decoder = new TextDecoder("latin1");

/** Concatenate multiple Uint8Arrays into one. */
export function concatBytes(arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) return new Uint8Array(0);
  if (arrays.length === 1) return arrays[0];
  const total = arrays.reduce((sum, a) => sum + a.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.byteLength;
  }
  return result;
}

/** Encode a string to UTF-8 Uint8Array. */
export function encode(str: string): Uint8Array {
  return textEncoder.encode(str);
}

/** Decode Uint8Array to string. */
export function decode(data: Uint8Array, encoding: "latin1" | "utf-8" = "utf-8"): string {
  return encoding === "latin1" ? latin1Decoder.decode(data) : utf8Decoder.decode(data);
}

/** Find the index of `needle` within `haystack`, or -1 if not found. */
export function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  const len = needle.length;
  const limit = haystack.length - len;
  for (let i = 0; i <= limit; i++) {
    let found = true;
    for (let j = 0; j < len; j++) {
      if (haystack[i + j] !== needle[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

/** Find the index of CRLF (\\r\\n) in data starting from `start`. */
export function indexOfCRLF(data: Uint8Array, start = 0): number {
  for (let i = start; i < data.length - 1; i++) {
    if (data[i] === 0x0d && data[i + 1] === 0x0a) {
      return i;
    }
  }
  return -1;
}
