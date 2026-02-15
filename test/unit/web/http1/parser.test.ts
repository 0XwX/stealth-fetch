import { describe, it, expect } from "vitest";
import { parseResponseHead } from "../../../../src/web/http1/parser.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("HTTP/1.1 Response Parser (web/Uint8Array)", () => {
  it("should parse a standard 200 response", () => {
    const raw = enc.encode(
      "HTTP/1.1 200 OK\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 13\r\n" +
        "\r\n" +
        '{"hello":"ok"}',
    );

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.status).toBe(200);
    expect(result!.response.statusText).toBe("OK");
    expect(result!.response.httpVersion).toBe("HTTP/1.1");
    expect(result!.response.headers["content-type"]).toBe("application/json");
    expect(result!.response.bodyMode).toBe("content-length");
    expect(result!.response.contentLength).toBe(13);
    expect(result!.bodyStart).toBeGreaterThan(0);
  });

  it("should parse chunked response", () => {
    const raw = enc.encode("HTTP/1.1 200 OK\r\n" + "Transfer-Encoding: chunked\r\n" + "\r\n");

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.bodyMode).toBe("chunked");
  });

  it("should parse response without Content-Length as close mode", () => {
    const raw = enc.encode("HTTP/1.1 200 OK\r\n" + "Content-Type: text/plain\r\n" + "\r\n");

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.bodyMode).toBe("close");
  });

  it("should return null if headers are incomplete", () => {
    const raw = enc.encode("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n");
    const result = parseResponseHead(raw);
    expect(result).toBeNull();
  });

  it("should parse 404 response", () => {
    const raw = enc.encode("HTTP/1.1 404 Not Found\r\n" + "Content-Length: 0\r\n" + "\r\n");

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.status).toBe(404);
    expect(result!.response.statusText).toBe("Not Found");
  });

  it("should handle HTTP/1.0 response", () => {
    const raw = enc.encode("HTTP/1.0 200 OK\r\n" + "Content-Length: 5\r\n" + "\r\n" + "hello");

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.httpVersion).toBe("HTTP/1.0");
  });

  it("should handle multiple values for same header", () => {
    const raw = enc.encode(
      "HTTP/1.1 200 OK\r\n" +
        "Set-Cookie: a=1\r\n" +
        "Set-Cookie: b=2\r\n" +
        "Content-Length: 0\r\n" +
        "\r\n",
    );

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.headers["set-cookie"]).toBe("a=1\nb=2");
  });

  it("should correctly identify body start position", () => {
    const headers = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n";
    const body = "hello";
    const raw = enc.encode(headers + body);

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.bodyStart).toBe(headers.length);

    const bodyData = dec.decode(raw.subarray(result!.bodyStart));
    expect(bodyData).toBe("hello");
  });
});
