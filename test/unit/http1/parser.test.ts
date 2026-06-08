import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { parseResponseHead } from "../../../src/http1/parser.js";

describe("HTTP/1.1 Response Parser", () => {
  it("should parse a standard 200 response", () => {
    const raw = Buffer.from(
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
    const raw = Buffer.from("HTTP/1.1 200 OK\r\n" + "Transfer-Encoding: chunked\r\n" + "\r\n");

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.bodyMode).toBe("chunked");
  });

  it("should hide Content-Length when Transfer-Encoding is present", () => {
    const raw = Buffer.from(
      "HTTP/1.1 200 OK\r\n" + "Transfer-Encoding: chunked\r\n" + "Content-Length: 999\r\n" + "\r\n",
    );

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.bodyMode).toBe("chunked");
    expect(result!.response.contentLength).toBe(0);
    expect(result!.response.headers["content-length"]).toBeUndefined();
    expect(result!.response.rawHeaders).toContainEqual(["content-length", "999"]);
  });

  it("should parse response without Content-Length as close mode", () => {
    const raw = Buffer.from("HTTP/1.1 200 OK\r\n" + "Content-Type: text/plain\r\n" + "\r\n");

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.bodyMode).toBe("close");
  });

  it("should return null if headers are incomplete", () => {
    const raw = Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n");
    const result = parseResponseHead(raw);
    expect(result).toBeNull();
  });

  it("should parse 404 response", () => {
    const raw = Buffer.from("HTTP/1.1 404 Not Found\r\n" + "Content-Length: 0\r\n" + "\r\n");

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.status).toBe(404);
    expect(result!.response.statusText).toBe("Not Found");
  });

  it("should handle HTTP/1.0 response", () => {
    const raw = Buffer.from("HTTP/1.0 200 OK\r\n" + "Content-Length: 5\r\n" + "\r\n" + "hello");

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.httpVersion).toBe("HTTP/1.0");
  });

  it("should handle multiple values for same header", () => {
    const raw = Buffer.from(
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

  it("should accept repeated identical Content-Length values", () => {
    const raw = Buffer.from(
      "HTTP/1.1 200 OK\r\n" + "Content-Length: 5\r\n" + "Content-Length: 5\r\n" + "\r\nhello",
    );

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.headers["content-length"]).toBe("5");
    expect(result!.response.contentLength).toBe(5);
  });

  it("should accept comma-joined identical Content-Length values", () => {
    const raw = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 5, 5\r\n\r\nhello");

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.headers["content-length"]).toBe("5");
    expect(result!.response.contentLength).toBe(5);
  });

  it("should reject conflicting Content-Length values", () => {
    const raw = Buffer.from(
      "HTTP/1.1 200 OK\r\n" + "Content-Length: 5\r\n" + "Content-Length: 6\r\n" + "\r\nhello",
    );

    expect(() => parseResponseHead(raw)).toThrow("Conflicting Content-Length");
  });

  it("should reject invalid Content-Length values", () => {
    const raw = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 5x\r\n\r\nhello");

    expect(() => parseResponseHead(raw)).toThrow('Invalid Content-Length: "5x"');
  });

  it("should reject invalid Content-Length values even with Transfer-Encoding", () => {
    const raw = Buffer.from(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 5x\r\n\r\n",
    );

    expect(() => parseResponseHead(raw)).toThrow('Invalid Content-Length: "5x"');
  });

  it("should correctly identify body start position", () => {
    const headers = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n";
    const body = "hello";
    const raw = Buffer.from(headers + body);

    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.bodyStart).toBe(headers.length);

    const bodyData = raw.subarray(result!.bodyStart).toString();
    expect(bodyData).toBe("hello");
  });
});
