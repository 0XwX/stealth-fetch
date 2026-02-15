import { describe, it, expect, vi } from "vitest";
import { tryWithNat64, type Nat64Candidate, type HttpResponse } from "../../../src/web/client.js";
import { parseUrl } from "../../../src/utils/url.js";

function createMockResponse(tag: string): HttpResponse {
  const cancelFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  // Keep stream in "readable" state (don't close) so cancel() invokes the callback
  const body = new ReadableStream<Uint8Array>({
    pull() {
      // Never enqueue — simulates a long-lived body stream
    },
    cancel: cancelFn,
  });
  return {
    status: 200,
    statusText: "OK",
    headers: { "x-tag": tag },
    rawHeaders: [["x-tag", tag]],
    protocol: "http/1.1",
    body,
    async text() {
      return tag;
    },
    async json() {
      return { tag };
    },
    async arrayBuffer() {
      return new TextEncoder().encode(tag).buffer as ArrayBuffer;
    },
    getSetCookie() {
      return [];
    },
    _cancelFn: cancelFn,
  } as HttpResponse & { _cancelFn: ReturnType<typeof vi.fn> };
}

describe("tryWithNat64 hedging — loser body cleanup", () => {
  const candidates: Nat64Candidate[] = [
    { prefix: "2602:fc59:b0:64::", connectHostname: "[2602:fc59:b0:64::a]" },
    { prefix: "2602:fc59:11:64::", connectHostname: "[2602:fc59:11:64::a]" },
  ];
  const parsed = parseUrl("https://example.com/test");

  it("should cancel loser response body when both candidates succeed", async () => {
    const winnerResp = createMockResponse("winner") as HttpResponse & {
      _cancelFn: ReturnType<typeof vi.fn>;
    };
    const loserResp = createMockResponse("loser") as HttpResponse & {
      _cancelFn: ReturnType<typeof vi.fn>;
    };

    // First candidate: slow (300ms > 200ms hedge delay), becomes loser
    // Second candidate: fast (10ms), becomes winner
    const attemptFn = vi
      .fn<(c: Nat64Candidate, s: AbortSignal) => Promise<HttpResponse>>()
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 300));
        return loserResp;
      })
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 10));
        return winnerResp;
      });

    const ac = new AbortController();
    const result = await tryWithNat64(
      candidates,
      parsed,
      ac.signal,
      false, // isStreamBody
      true, // isIdempotent
      attemptFn,
    );

    expect(result.status).toBe(200);
    expect(result.headers["x-tag"]).toBe("winner");
    expect(attemptFn).toHaveBeenCalledTimes(2);

    // Loser's attemptFn is still sleeping (300ms). Wait for it to resolve,
    // then the .then() cleanup will call body.cancel().
    await new Promise(r => setTimeout(r, 400));

    expect(loserResp._cancelFn).toHaveBeenCalled();
  });
});
