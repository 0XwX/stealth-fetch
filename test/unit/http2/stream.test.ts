import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import { Http2Stream } from "../../../src/http2/stream.js";
import { ErrorCode, DEFAULT_INITIAL_WINDOW_SIZE } from "../../../src/http2/constants.js";

describe("Http2Stream", () => {
  describe("construction", () => {
    it("should initialize with given id and idle state", () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      expect(s.id).toBe(1);
      expect(s.state).toBe("idle");
    });

    it("should have a ReadableStream body", () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      expect(s.body).toBeInstanceOf(ReadableStream);
    });

    it("should have a FlowControlWindow", () => {
      const s = new Http2Stream(1, 1000);
      expect(s.sendWindow.size).toBe(1000);
    });
  });

  describe("state transitions", () => {
    it("idle -> open on open()", () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      expect(s.state).toBe("open");
    });

    it("open -> half-closed-local on halfCloseLocal()", () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      s.halfCloseLocal();
      expect(s.state).toBe("half-closed-local");
    });

    it("open -> half-closed-remote on remote END_STREAM via handleHeaders", () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      // Set up response promise first
      s.waitForResponse();
      s.handleHeaders([[":status", "200"]], true);
      expect(s.state).toBe("half-closed-remote");
    });

    it("open -> half-closed-remote on remote END_STREAM via handleData", () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      s.waitForResponse();
      s.handleHeaders([[":status", "200"]], false);
      s.handleData(Buffer.from("done"), true);
      expect(s.state).toBe("half-closed-remote");
    });

    it("half-closed-local + remote END_STREAM -> closed", () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      s.halfCloseLocal();
      expect(s.state).toBe("half-closed-local");

      s.waitForResponse();
      s.handleHeaders([[":status", "200"]], true);
      expect(s.state).toBe("closed");
    });

    it("half-closed-remote + halfCloseLocal -> closed", () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      s.waitForResponse();
      s.handleHeaders([[":status", "200"]], true); // remote end
      expect(s.state).toBe("half-closed-remote");

      s.halfCloseLocal();
      expect(s.state).toBe("closed");
    });

    it("any state -> closed on RST_STREAM", () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      s.handleRstStream(ErrorCode.CANCEL);
      expect(s.state).toBe("closed");
    });

    it("should emit close event on close", () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      const closeFn = vi.fn();
      s.on("close", closeFn);

      s.open();
      s.handleRstStream(ErrorCode.CANCEL);

      expect(closeFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleHeaders", () => {
    it("should extract :status pseudo-header", async () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      const promise = s.waitForResponse();

      s.handleHeaders(
        [
          [":status", "404"],
          ["content-type", "text/html"],
        ],
        false,
      );

      const resp = await promise;
      expect(resp.status).toBe(404);
      expect(resp.headers["content-type"]).toBe("text/html");
    });

    it("should not include pseudo-headers in headers object", async () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      const promise = s.waitForResponse();

      s.handleHeaders(
        [
          [":status", "200"],
          [":content-type", "should-be-excluded"],
          ["x-custom", "value"],
        ],
        false,
      );

      const resp = await promise;
      expect(resp.headers[":status"]).toBeUndefined();
      expect(resp.headers[":content-type"]).toBeUndefined();
      expect(resp.headers["x-custom"]).toBe("value");
    });

    it("should merge duplicate headers with comma", async () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      const promise = s.waitForResponse();

      s.handleHeaders(
        [
          [":status", "200"],
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
        ],
        false,
      );

      const resp = await promise;
      expect(resp.headers["set-cookie"]).toBe("a=1, b=2");
    });

    it("should default to status 200 if :status missing", async () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      const promise = s.waitForResponse();

      s.handleHeaders([["content-type", "text/plain"]], false);

      const resp = await promise;
      expect(resp.status).toBe(200);
    });
  });

  describe("waitForResponse", () => {
    it("should resolve when headers arrive after call", async () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      const promise = s.waitForResponse();

      s.handleHeaders([[":status", "200"]], false);
      const resp = await promise;
      expect(resp.status).toBe(200);
    });

    it("should resolve immediately if headers already arrived", async () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();

      // Headers arrive before waitForResponse
      const dummyPromise = s.waitForResponse();
      s.handleHeaders(
        [
          [":status", "301"],
          ["location", "/new"],
        ],
        false,
      );
      await dummyPromise;

      // Second call should resolve immediately
      const resp = await s.waitForResponse();
      expect(resp.status).toBe(301);
      expect(resp.headers["location"]).toBe("/new");
    });

    it("should reject on RST_STREAM", async () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      const promise = s.waitForResponse();

      s.handleRstStream(ErrorCode.INTERNAL_ERROR);

      await expect(promise).rejects.toThrow("Stream reset by peer");
    });
  });

  describe("timeouts", () => {
    it("should timeout waiting for response headers", async () => {
      vi.useFakeTimers();
      try {
        const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
        s.open();
        const promise = s.waitForResponse(10);
        await vi.advanceTimersByTimeAsync(20);
        await expect(promise).rejects.toThrow("Headers timeout after 10ms");
      } finally {
        vi.useRealTimers();
      }
    });

    it("should timeout waiting for response body data (idle)", async () => {
      vi.useFakeTimers();
      try {
        const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
        s.open();
        s.setBodyTimeout(10);
        const promise = s.waitForResponse();
        s.handleHeaders([[":status", "200"]], false);
        await promise;

        const reader = s.body.getReader();
        const readPromise = reader.read();

        await vi.advanceTimersByTimeAsync(20);
        await expect(readPromise).rejects.toThrow("Body timeout after 10ms");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("handleData / body stream", () => {
    it("should enqueue data chunks to body ReadableStream", async () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      s.waitForResponse();
      s.handleHeaders([[":status", "200"]], false);

      s.handleData(Buffer.from("hello "), false);
      s.handleData(Buffer.from("world"), true);

      const reader = s.body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const text = new TextDecoder().decode(
        new Uint8Array(chunks.reduce((arr, c) => [...arr, ...c], [] as number[])),
      );
      expect(text).toBe("hello world");
    });

    it("should close body stream on END_STREAM with headers", async () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      s.waitForResponse();
      s.handleHeaders([[":status", "204"]], true); // endStream=true

      const reader = s.body.getReader();
      const { done } = await reader.read();
      expect(done).toBe(true);
    });
  });

  describe("handleWindowUpdate", () => {
    it("should update send window", () => {
      const s = new Http2Stream(1, 100);
      s.handleWindowUpdate(50);
      expect(s.sendWindow.size).toBe(150);
    });
  });

  describe("handleRstStream", () => {
    it("should error the body stream", async () => {
      const s = new Http2Stream(1, DEFAULT_INITIAL_WINDOW_SIZE);
      s.open();
      s.waitForResponse();
      s.handleHeaders([[":status", "200"]], false);

      s.handleRstStream(ErrorCode.CANCEL);

      const reader = s.body.getReader();
      await expect(reader.read()).rejects.toThrow("Stream reset by peer");
    });

    it("should cancel send window waiters with rejection", async () => {
      const s = new Http2Stream(1, 0); // zero window
      const p = s.sendWindow.consume(10);

      s.handleRstStream(ErrorCode.CANCEL);
      await expect(p).rejects.toThrow("Flow control window cancelled");
    });
  });
});
