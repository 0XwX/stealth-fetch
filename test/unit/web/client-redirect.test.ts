import { describe, expect, it, vi } from "vitest";
import {
  createRequestFn,
  type HttpResponse,
  type InnerRequestFn,
} from "../../../src/web/client.js";

function pendingBody(cancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ cancel });
}

function response(status: number, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    statusText: status === 200 ? "OK" : "Redirect",
    headers,
    rawHeaders: Object.entries(headers),
    protocol: "http/1.1",
    body: pendingBody(),
    async text() {
      return "";
    },
    async json() {
      return {};
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
    getSetCookie() {
      return [];
    },
  };
}

describe("web redirect handling", () => {
  it("should preserve PUT on 302 redirects and strip sensitive cross-origin headers", async () => {
    const inner = vi
      .fn<InnerRequestFn>()
      .mockResolvedValueOnce(response(302, { location: "https://other.example:8443/next" }))
      .mockResolvedValueOnce(response(200));
    const request = createRequestFn(inner);

    await request("https://example.com/start", {
      method: "PUT",
      body: new TextEncoder().encode("payload"),
      headers: {
        authorization: "Bearer token",
        "x-api-key": "secret",
        "x-keep": "ok",
      },
    });

    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner.mock.calls[1]![1].method).toBe("PUT");
    expect(inner.mock.calls[1]![1].headers["authorization"]).toBeUndefined();
    expect(inner.mock.calls[1]![1].headers["x-api-key"]).toBeUndefined();
    expect(inner.mock.calls[1]![1].headers["x-keep"]).toBe("ok");
    expect(inner.mock.calls[1]![1].headers["host"]).toBe("other.example:8443");
  });

  it("should rewrite POST to GET on 301 and not read the redirect body", async () => {
    const cancel = vi.fn();
    const first = response(301, { location: "https://example.com/next" });
    first.body = pendingBody(cancel);
    const inner = vi
      .fn<InnerRequestFn>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(response(200));
    const request = createRequestFn(inner);

    await request("https://example.com/start", {
      method: "POST",
      body: new TextEncoder().encode("payload"),
    });

    expect(inner.mock.calls[1]![1].method).toBe("GET");
    expect(inner.mock.calls[1]![2]).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it("should preserve HEAD on 303 redirects", async () => {
    const inner = vi
      .fn<InnerRequestFn>()
      .mockResolvedValueOnce(response(303, { location: "https://example.com/next" }))
      .mockResolvedValueOnce(response(200));
    const request = createRequestFn(inner);

    await request("https://example.com/start", { method: "HEAD" });

    expect(inner.mock.calls[1]![1].method).toBe("HEAD");
  });
});
