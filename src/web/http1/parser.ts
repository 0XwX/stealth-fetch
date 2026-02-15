/**
 * HTTP/1.1 response parser (Uint8Array version, no node:buffer).
 */
import { indexOf, decode } from "../bytes.js";

export interface ParsedResponse {
  httpVersion: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawHeaders: Array<[string, string]>;
  bodyMode: "content-length" | "chunked" | "close";
  contentLength: number;
}

const DOUBLE_CRLF = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

/**
 * Parse HTTP/1.1 response status line and headers from raw data.
 * Returns null if not enough data has been received yet.
 */
export function parseResponseHead(data: Uint8Array): {
  response: ParsedResponse;
  bodyStart: number;
} | null {
  const headerEnd = indexOf(data, DOUBLE_CRLF);
  if (headerEnd === -1) return null;

  const headSection = decode(data.subarray(0, headerEnd), "latin1");
  const bodyStart = headerEnd + 4;

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
    if (headers["transfer-encoding"].includes("chunked")) {
      bodyMode = "chunked";
    }
  } else if (headers["content-length"]) {
    const cl = parseInt(headers["content-length"], 10);
    if (!isNaN(cl) && cl >= 0) {
      bodyMode = "content-length";
      contentLength = cl;
    }
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
