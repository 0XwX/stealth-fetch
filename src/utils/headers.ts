/**
 * Header utilities for HTTP/1.1 and HTTP/2.
 * HTTP/2 requires lowercase header names (RFC 7540 Section 8.1.2).
 */

/**
 * Build HTTP/2 pseudo-headers from request parameters.
 * Pseudo-headers must come before regular headers (RFC 7540 Section 8.1.2.1).
 */
export function buildPseudoHeaders(
  method: string,
  hostname: string,
  path: string,
  scheme: "https" | "http",
): Array<[string, string]> {
  return [
    [":method", method.toUpperCase()],
    [":path", path],
    [":scheme", scheme],
    [":authority", hostname],
  ];
}

/**
 * Merge pseudo-headers and user headers into an ordered array.
 * Pseudo-headers first, then regular headers (all lowercase).
 */
export function mergeHeaders(
  pseudo: Array<[string, string]>,
  headers: Record<string, string>,
): Array<[string, string]> {
  const result: Array<[string, string]> = [...pseudo];

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    // Skip pseudo-headers and connection-specific headers (RFC 7540 Section 8.1.2.2)
    if (
      lower.startsWith(":") ||
      lower === "connection" ||
      lower === "transfer-encoding" ||
      lower === "keep-alive" ||
      lower === "upgrade"
    ) {
      continue;
    }
    result.push([lower, value]);
  }

  return result;
}

const INVALID_HEADER_CHAR_RE = /[\r\n\0]/;

/**
 * Serialize headers into HTTP/1.1 format: "Key: Value\r\n"
 * Validates against header injection (CR/LF/NUL).
 */
export function serializeHttp1Headers(headers: Record<string, string>): string {
  let result = "";
  for (const [key, value] of Object.entries(headers)) {
    if (INVALID_HEADER_CHAR_RE.test(key) || INVALID_HEADER_CHAR_RE.test(value)) {
      throw new Error(`Invalid header: contains CR/LF/NUL in "${key}"`);
    }
    result += `${key}: ${value}\r\n`;
  }
  return result;
}
