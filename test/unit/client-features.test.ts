import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { parseResponseHead } from "../../src/http1/parser.js";
import { Http2Stream } from "../../src/http2/stream.js";
import { DEFAULT_INITIAL_WINDOW_SIZE } from "../../src/http2/constants.js";
import { request, normalizeHeaders } from "../../src/client.js";

describe("rawHeaders in HTTP/1.1 parser", () => {
  it("should include rawHeaders array", () => {
    const raw = Buffer.from(
      "HTTP/1.1 200 OK\r\n" + "Content-Type: application/json\r\n" + "X-Custom: hello\r\n" + "\r\n",
    );
    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.rawHeaders).toEqual([
      ["content-type", "application/json"],
      ["x-custom", "hello"],
    ]);
  });

  it("should preserve multiple values for same header in rawHeaders", () => {
    const raw = Buffer.from(
      "HTTP/1.1 200 OK\r\n" +
        "Set-Cookie: a=1\r\n" +
        "Set-Cookie: b=2\r\n" +
        "Set-Cookie: c=3\r\n" +
        "\r\n",
    );
    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();

    // rawHeaders preserves each value separately
    expect(result!.response.rawHeaders).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
      ["set-cookie", "c=3"],
    ]);

    // headers joins with newline (RFC 6265: set-cookie cannot be comma-joined)
    expect(result!.response.headers["set-cookie"]).toBe("a=1\nb=2\nc=3");
  });

  it("should return empty rawHeaders for no-header response", () => {
    const raw = Buffer.from("HTTP/1.1 204 No Content\r\n\r\n");
    const result = parseResponseHead(raw);
    expect(result).not.toBeNull();
    expect(result!.response.rawHeaders).toEqual([]);
  });
});

describe("rawHeaders in HTTP/2 stream", () => {
  it("should include rawHeaders in response data", async () => {
    const stream = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
    stream.open();

    const responsePromise = stream.waitForResponse();
    stream.handleHeaders(
      [
        [":status", "200"],
        ["content-type", "text/html"],
        ["x-request-id", "abc123"],
      ],
      false,
    );

    const data = await responsePromise;
    expect(data.rawHeaders).toEqual([
      ["content-type", "text/html"],
      ["x-request-id", "abc123"],
    ]);
    // Pseudo headers excluded from rawHeaders
    expect(data.rawHeaders.some(([n]) => n === ":status")).toBe(false);
  });

  it("should preserve multi-value headers in rawHeaders", async () => {
    const stream = new Http2Stream(3, DEFAULT_INITIAL_WINDOW_SIZE);
    stream.open();

    const responsePromise = stream.waitForResponse();
    stream.handleHeaders(
      [
        [":status", "200"],
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
      false,
    );

    const data = await responsePromise;
    expect(data.rawHeaders).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
    expect(data.headers["set-cookie"]).toBe("a=1, b=2");
  });

  it("should include rawHeaders when headers already received (waitForResponse sync path)", async () => {
    const stream = new Http2Stream(5, DEFAULT_INITIAL_WINDOW_SIZE);
    stream.open();

    // Send headers first
    stream.handleHeaders(
      [
        [":status", "301"],
        ["location", "https://example.com/new"],
      ],
      true,
    );

    // Then wait (sync path)
    const data = await stream.waitForResponse();
    expect(data.status).toBe(301);
    expect(data.rawHeaders).toEqual([["location", "https://example.com/new"]]);
  });
});

describe("normalizeHeaders", () => {
  it("should convert Headers object to Record", () => {
    const headers = new Headers({ "content-type": "application/json", "x-custom": "value" });
    const result = normalizeHeaders(headers);
    expect(result["content-type"]).toBe("application/json");
    expect(result["x-custom"]).toBe("value");
  });

  it("should pass through Record as shallow copy", () => {
    const original = { "content-type": "text/plain" };
    const result = normalizeHeaders(original);
    expect(result["content-type"]).toBe("text/plain");
    // Should be a copy, not the same reference
    expect(result).not.toBe(original);
  });

  it("should return empty object for undefined", () => {
    expect(normalizeHeaders(undefined)).toEqual({});
  });

  it("should handle Headers with multi-value append", () => {
    const headers = new Headers();
    headers.append("accept", "text/html");
    headers.append("accept", "application/json");
    const result = normalizeHeaders(headers);
    // Headers.forEach merges with ", " per Web API spec
    expect(result["accept"]).toBe("text/html, application/json");
  });
});

describe("ReadableStream body input validation", () => {
  it("should throw TypeError for locked ReadableStream body", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("test"));
        controller.close();
      },
    });

    // Lock the stream by getting a reader
    stream.getReader();

    await expect(request("https://example.com", { body: stream })).rejects.toThrow(TypeError);

    await expect(request("https://example.com", { body: stream })).rejects.toThrow(
      "ReadableStream body is already locked",
    );
  });
});
