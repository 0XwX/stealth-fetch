import { describe, it, expect } from "vitest";
import { toWebResponse } from "../../../src/compat/web.js";
import type { HttpResponse } from "../../../src/client.js";

// Helper to create a mock HttpResponse
function mockHttpResponse(overrides: Partial<HttpResponse> = {}): HttpResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: {},
    rawHeaders: [],
    protocol: "http/1.1",
    body: new ReadableStream(),
    text: async () => "",
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
    getSetCookie: () => [],
    ...overrides,
  } as HttpResponse;
}

describe("toWebResponse", () => {
  it("should convert a basic HttpResponse to a Web Response", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("test body"));
        controller.close();
      },
    });

    const mockRes = mockHttpResponse({
      status: 201,
      statusText: "Created",
      headers: { "content-type": "text/plain" },
      body: stream,
    });

    const webRes = toWebResponse(mockRes) as Response;

    expect(webRes).toBeInstanceOf(Response);
    expect(webRes.status).toBe(201);
    expect(webRes.statusText).toBe("Created");
    expect(webRes.headers.get("content-type")).toBe("text/plain");

    const text = await webRes.text();
    expect(text).toBe("test body");
  });

  it("should utilize rawHeaders for multi-value headers", () => {
    const mockRes = mockHttpResponse({
      headers: {},
      rawHeaders: [
        ["Set-Cookie", "a=1"],
        ["Set-Cookie", "b=2"],
        ["X-Custom", "value"],
      ],
    });

    const webRes = toWebResponse(mockRes) as Response;

    expect(webRes.headers.get("x-custom")).toBe("value");

    // Check Set-Cookie handling
    // Note: Standard Headers API behavior varies on get("set-cookie").
    // Some implementations join with comma, others return only first.
    // However, since we used headers.append(), it should be correct internally.
    // Let's check via getSetCookie() if available or iteration.

    // In node/vitest environment, let's see what happens.
    // Usually get("set-cookie") returns comma separated values.

    const cookieHeader = webRes.headers.get("set-cookie");
    // Depending on the Headers implementation, it might be "a=1, b=2" or just "a=1".
    // But since the code iterates rawHeaders and calls append(), it's doing the right thing.

    // Let's verify via checking if the string contains the values.
    expect(cookieHeader).toContain("a=1");
    expect(cookieHeader).toContain("b=2");
  });

  it("should fallback to headers object if rawHeaders is empty", () => {
    const mockRes = mockHttpResponse({
      headers: { "content-type": "application/json" },
      rawHeaders: [],
    });

    const webRes = toWebResponse(mockRes) as Response;
    expect(webRes.headers.get("content-type")).toBe("application/json");
  });

  it("should throw if the body stream is locked", () => {
    const stream = new ReadableStream();
    const reader = stream.getReader(); // Lock the stream

    const mockRes = mockHttpResponse({
      body: stream,
    });

    expect(() => toWebResponse(mockRes)).toThrow(/locked/);

    reader.releaseLock();
  });

  it("should return a WebResponsePair when tee is true", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("teed body"));
        controller.close();
      },
    });

    const mockRes = mockHttpResponse({
      body: stream,
    });

    const result = toWebResponse(mockRes, { tee: true });

    // It should return an object with response and clone
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toHaveProperty("response");
    expect(result).toHaveProperty("clone");

    const pair = result as { response: Response; clone: Response };
    expect(pair.response).toBeInstanceOf(Response);
    expect(pair.clone).toBeInstanceOf(Response);

    // Verify both streams work
    const text1 = await pair.response.text();
    const text2 = await pair.clone.text();

    expect(text1).toBe("teed body");
    expect(text2).toBe("teed body");
  });

  it("should return a single Response when tee is false or undefined", () => {
    const res1 = toWebResponse(mockHttpResponse(), { tee: false });
    expect(res1).toBeInstanceOf(Response);

    const res2 = toWebResponse(mockHttpResponse());
    expect(res2).toBeInstanceOf(Response);
  });
});
