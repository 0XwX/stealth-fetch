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

// RFC 7230 3.2.6. Field Value Components: token = 1*tchar
// tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
const TOKEN_RE = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Validate header name against RFC 7230 token characters.
 */
export function validateHeaderName(name: string): void {
  if (!TOKEN_RE.test(name)) {
    throw new Error(`Invalid header name: ${JSON.stringify(name)} contains invalid characters`);
  }
}

/**
 * Validate header value against CR/LF/NUL injection.
 */
export function validateHeaderValue(name: string, value: string): void {
  if (INVALID_HEADER_CHAR_RE.test(value)) {
    throw new Error(`Invalid header value for "${name}": contains CR/LF/NUL`);
  }
}

/**
 * Serialize headers into HTTP/1.1 format: "Key: Value\r\n"
 * Validates against header injection (CR/LF/NUL).
 */
export function serializeHttp1Headers(headers: Record<string, string>): string {
  let result = "";
  for (const [key, value] of Object.entries(headers)) {
    validateHeaderName(key);
    validateHeaderValue(key, value);
    result += `${key}: ${value}\r\n`;
  }
  return result;
}

/**
 * Validate HTTP method to prevent CRLF injection and ensure valid token characters.
 */
export function validateMethod(method: string): void {
  if (!TOKEN_RE.test(method)) {
    throw new Error(`Invalid method: ${JSON.stringify(method)} contains invalid characters`);
  }
}

// RFC 7230 3.1.1 request-target cannot contain whitespace (SP/HTAB) or CR/LF
const INVALID_PATH_RE = /[\r\n\s]/;

/**
 * Validate HTTP path to prevent Request Splitting and ensure valid request-target.
 */
export function validatePath(path: string): void {
  if (INVALID_PATH_RE.test(path)) {
    throw new Error(
      `Invalid path: ${JSON.stringify(path)} contains whitespace or control characters`,
    );
  }
}
