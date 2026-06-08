import { describe, expect, it, vi } from "vitest";
import { createRequestFn, type HttpResponse, type InnerRequestFn } from "../../src/web/client.js";

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): HttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    statusText: status === 200 ? "OK" : "Redirect",
    headers,
    rawHeaders: Object.entries(headers),
    protocol: "http/1.1",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
    async arrayBuffer() {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    },
    getSetCookie() {
      return [];
    },
  };
}

describe("stealth-fetch/lite — request pipeline", () => {
  it("should make an HTTP/1.1 GET request through the lite pipeline", async () => {
    const inner = vi
      .fn<InnerRequestFn>()
      .mockResolvedValue(
        response(200, JSON.stringify({ headers: { "User-Agent": "stealth-fetch/0.1" } })),
      );
    const request = createRequestFn(inner);

    const res = await request("https://example.com/headers", { timeout: 15000 });
    expect(res.status).toBe(200);

    const json = JSON.parse(await res.text());
    expect(json.headers).toBeDefined();
    expect(json.headers["Cf-Connecting-Ip"]).toBeUndefined();
    expect(inner).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "example.com", path: "/headers" }),
      expect.objectContaining({ method: "GET" }),
      null,
      expect.any(AbortSignal),
    );
  });

  it("should handle POST with JSON body", async () => {
    const inner = vi.fn<InnerRequestFn>().mockImplementation(async (_parsed, _options, body) => {
      const text = new TextDecoder().decode(body as Uint8Array);
      return response(200, JSON.stringify({ json: JSON.parse(text) }));
    });
    const request = createRequestFn(inner);

    const res = await request("https://example.com/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: "lite" }),
      timeout: 15000,
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).json).toEqual({ test: "lite" });
  });

  it("should follow redirects", async () => {
    const inner = vi
      .fn<InnerRequestFn>()
      .mockResolvedValueOnce(response(302, "", { location: "https://example.com/final" }))
      .mockResolvedValueOnce(response(200, "ok"));
    const request = createRequestFn(inner);

    const res = await request("https://example.com/redirect/1", { timeout: 15000 });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner.mock.calls[1]![0].path).toBe("/final");
  });

  it("should respect timeout", async () => {
    const inner = vi.fn<InnerRequestFn>().mockImplementation(
      (_parsed, _options, _body, signal) =>
        new Promise<HttpResponse>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const request = createRequestFn(inner);

    await expect(request("https://example.com/delay/10", { timeout: 100 })).rejects.toThrow(
      /timed out/i,
    );
  });
});
