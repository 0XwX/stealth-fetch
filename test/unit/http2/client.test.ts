import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { Http2Client } from "../../../src/http2/client.js";
import { Http2Connection } from "../../../src/http2/connection.js";
import { createWasmTLSSocket, createPlainSocket } from "../../../src/socket/tls.js";

// Mock dependencies
vi.mock("../../../src/socket/tls.js", () => ({
  createWasmTLSSocket: vi.fn(),
  createPlainSocket: vi.fn(),
}));

vi.mock("../../../src/http2/connection.js", () => {
  return {
    Http2Connection: vi.fn(),
  };
});

describe("Http2Client", () => {
  let mockConnection: any;
  let mockStream: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStream = {
      setBodyTimeout: vi.fn(),
      waitForResponse: vi.fn().mockResolvedValue({
        status: 200,
        headers: { "content-type": "text/plain" },
        rawHeaders: [["content-type", "text/plain"]],
        body: new ReadableStream(),
      }),
      body: new ReadableStream(),
    };

    mockConnection = {
      startInitialize: vi.fn().mockResolvedValue(undefined),
      createStream: vi.fn().mockReturnValue(mockStream),
      sendHeaders: vi.fn().mockResolvedValue(undefined),
      sendData: vi.fn().mockResolvedValue(undefined),
      isReady: true,
      activeStreamCount: 0,
      maxConcurrentStreams: 100,
      on: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (Http2Connection as unknown as Mock).mockImplementation(() => mockConnection);
  });

  describe("fromConnection", () => {
    it("should create a client from an existing connection", () => {
      const client = Http2Client.fromConnection(mockConnection);
      expect(client).toBeInstanceOf(Http2Client);
      expect(client.isReady).toBe(true);
    });
  });

  describe("connect", () => {
    it("should create a TLS socket and initialize connection", async () => {
      const mockSocket = {};
      (createWasmTLSSocket as Mock).mockResolvedValue(mockSocket);

      const client = await Http2Client.connect("example.com");

      expect(createWasmTLSSocket).toHaveBeenCalledWith(
        "example.com",
        443,
        ["h2"],
        undefined,
        undefined,
      );
      expect(Http2Connection).toHaveBeenCalledWith(mockSocket, {});
      expect(mockConnection.startInitialize).toHaveBeenCalled();
      expect(client).toBeInstanceOf(Http2Client);
    });

    it("should create a plain socket if tls is false", async () => {
      const mockSocket = {};
      (createPlainSocket as Mock).mockResolvedValue(mockSocket);

      const client = await Http2Client.connect("example.com", 80, false);

      expect(createPlainSocket).toHaveBeenCalledWith("example.com", 80, undefined);
      expect(Http2Connection).toHaveBeenCalledWith(mockSocket, {});
      expect(client).toBeInstanceOf(Http2Client);
    });
  });

  describe("request", () => {
    it("should send a GET request with correct headers", async () => {
      const client = Http2Client.fromConnection(mockConnection);
      const url = "https://example.com/path";

      const response = await client.request(url);

      expect(mockConnection.createStream).toHaveBeenCalled();

      // Verify headers
      const expectedHeaders = expect.arrayContaining([
        [":method", "GET"],
        [":authority", "example.com"],
        [":path", "/path"],
        [":scheme", "https"],
      ]);
      expect(mockConnection.sendHeaders).toHaveBeenCalledWith(mockStream, expectedHeaders, true); // endStream=true for GET

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("text/plain");
    });

    it("should send a POST request with buffer body and content-length", async () => {
      const client = Http2Client.fromConnection(mockConnection);
      const body = new TextEncoder().encode("hello world");

      await client.request("https://example.com", {
        method: "POST",
        body,
      });

      expect(mockConnection.sendHeaders).toHaveBeenCalledWith(
        mockStream,
        expect.arrayContaining([
          [":method", "POST"],
          ["content-length", String(body.byteLength)],
        ]),
        false, // endStream=false because body follows
      );

      expect(mockConnection.sendData).toHaveBeenCalledWith(mockStream, expect.anything(), true);
    });

    it("should send a POST request with stream body", async () => {
      const client = Http2Client.fromConnection(mockConnection);
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });

      await client.request("https://example.com", {
        method: "POST",
        body: bodyStream,
      });

      expect(mockConnection.sendHeaders).toHaveBeenCalledWith(
        mockStream,
        expect.arrayContaining([[":method", "POST"]]),
        false,
      );

      // Should not automatically add content-length for stream
      const calls = (mockConnection.sendHeaders as Mock).mock.calls[0];
      const headers = calls[1] as [string, string][];
      const cl = headers.find(([k]) => k === "content-length");
      expect(cl).toBeUndefined();

      expect(mockConnection.sendData).toHaveBeenCalledWith(mockStream, bodyStream, true);
    });

    it("should set body timeout on stream if provided", async () => {
      const client = Http2Client.fromConnection(mockConnection);
      await client.request("https://example.com", {
        bodyTimeout: 5000,
      });

      expect(mockStream.setBodyTimeout).toHaveBeenCalledWith(5000);
    });

    it("should pass headers timeout to waitForResponse", async () => {
      const client = Http2Client.fromConnection(mockConnection);
      await client.request("https://example.com", {
        headersTimeout: 3000,
      });

      expect(mockStream.waitForResponse).toHaveBeenCalledWith(3000);
    });
  });

  describe("properties and lifecycle", () => {
    it("should delegate getters to connection", () => {
      const client = Http2Client.fromConnection(mockConnection);

      expect(client.isReady).toBe(true);
      expect(client.activeStreamCount).toBe(0);
      expect(client.maxConcurrentStreams).toBe(100);
      expect(client.hasCapacity).toBe(true);
    });

    it("should register and remove goaway listener", () => {
      const client = Http2Client.fromConnection(mockConnection);
      const callback = () => {};

      client.onGoaway(callback);
      expect(mockConnection.on).toHaveBeenCalledWith("goaway", callback);

      client.offGoaway(callback);
      expect(mockConnection.removeListener).toHaveBeenCalledWith("goaway", callback);
    });

    it("should close connection", async () => {
      const client = Http2Client.fromConnection(mockConnection);
      await client.close();
      expect(mockConnection.close).toHaveBeenCalled();
    });
  });
});
