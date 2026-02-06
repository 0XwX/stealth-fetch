/**
 * HTTP/1.1 response parser.
 * State machine that parses raw bytes into structured response objects.
 */
import { Buffer } from "node:buffer";

export interface ParsedResponse {
  httpVersion: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Raw headers preserving original order and multi-values */
  rawHeaders: Array<[string, string]>;
  /** How the body should be read */
  bodyMode: "content-length" | "chunked" | "close";
  /** Content-Length value (if bodyMode is "content-length") */
  contentLength: number;
}

const DOUBLE_CRLF = Buffer.from("\r\n\r\n");

/**
 * Parse HTTP/1.1 response status line and headers from raw data.
 * Returns null if not enough data has been received yet.
 */
export function parseResponseHead(data: Buffer): {
  response: ParsedResponse;
  bodyStart: number;
} | null {
  // Look for end of headers (double CRLF)
  const headerEnd = bufferIndexOf(data, DOUBLE_CRLF);
  if (headerEnd === -1) return null;

  const headSection = data.subarray(0, headerEnd).toString("latin1");
  const bodyStart = headerEnd + 4; // skip \r\n\r\n

  const lines = headSection.split("\r\n");
  if (lines.length === 0) return null;

  // Parse status line: "HTTP/1.1 200 OK"
  const statusLine = lines[0];
  const firstSpace = statusLine.indexOf(" ");
  if (firstSpace === -1) return null;

  const httpVersion = statusLine.substring(0, firstSpace);
  const rest = statusLine.substring(firstSpace + 1);
  const secondSpace = rest.indexOf(" ");

  const status =
    secondSpace === -1 ? parseInt(rest, 10) : parseInt(rest.substring(0, secondSpace), 10);

  if (isNaN(status) || status < 100 || status > 999) return null;

  const statusText = secondSpace === -1 ? "" : rest.substring(secondSpace + 1);

  // Parse headers
  const headers: Record<string, string> = {};
  const rawHeaders: Array<[string, string]> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();

    rawHeaders.push([key, value]);

    // Merge multiple values: comma-join per RFC 7230, except set-cookie (RFC 6265)
    if (headers[key]) {
      headers[key] += key === "set-cookie" ? `\n${value}` : `, ${value}`;
    } else {
      headers[key] = value;
    }
  }

  // Determine body mode
  let bodyMode: ParsedResponse["bodyMode"] = "close";
  let contentLength = 0;

  if (headers["transfer-encoding"]) {
    // RFC 7230 Section 3.3.3: Transfer-Encoding takes precedence over Content-Length
    if (headers["transfer-encoding"].includes("chunked")) {
      bodyMode = "chunked";
    }
    // Non-chunked Transfer-Encoding: read until connection closes (bodyMode stays "close")
  } else if (headers["content-length"]) {
    const cl = parseInt(headers["content-length"], 10);
    if (!isNaN(cl) && cl >= 0) {
      bodyMode = "content-length";
      contentLength = cl;
    }
    // Invalid Content-Length falls through to "close" mode
  }

  return {
    response: {
      httpVersion,
      status,
      statusText,
      headers,
      rawHeaders,
      bodyMode,
      contentLength,
    },
    bodyStart,
  };
}

/** Find the index of a needle buffer within a haystack buffer */
function bufferIndexOf(haystack: Buffer, needle: Buffer): number {
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
