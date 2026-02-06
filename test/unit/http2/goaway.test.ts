import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { Http2Connection } from "../../../src/http2/connection.js";
import { FrameType, ErrorCode, FRAME_HEADER_SIZE } from "../../../src/http2/constants.js";

/**
 * Create a mock Duplex socket that:
 * - captures write() calls for inspection
 * - allows feeding data via emit('data', ...)
 */
function createMockSocket() {
  const ee = new EventEmitter();
  const written: Buffer[] = [];

  const socket = Object.assign(ee, {
    write(data: Buffer, cb?: (err?: Error | null) => void) {
      written.push(Buffer.from(data));
      if (cb) queueMicrotask(() => cb());
    },
    end: vi.fn(),
    destroy: vi.fn(),
  });

  return { socket: socket as any, written };
}

/** Build a raw GOAWAY frame binary to feed to the parser */
function buildGoawayFrame(lastStreamId: number, errorCode: ErrorCode): Buffer {
  // GOAWAY payload: 4 bytes lastStreamId + 4 bytes errorCode
  const payload = Buffer.alloc(8);
  payload.writeUInt32BE(lastStreamId & 0x7fffffff, 0);
  payload.writeUInt32BE(errorCode, 4);

  // Frame header: 9 bytes
  const frame = Buffer.alloc(FRAME_HEADER_SIZE + payload.length);
  // Length (3 bytes)
  frame.writeUIntBE(payload.length, 0, 3);
  // Type
  frame[3] = FrameType.GOAWAY;
  // Flags
  frame[4] = 0;
  // Stream ID (always 0 for GOAWAY)
  frame.writeUInt32BE(0, 5);
  // Payload
  payload.copy(frame, FRAME_HEADER_SIZE);

  return frame;
}

/** Build a raw SETTINGS frame (ACK) for handshake */
function buildSettingsAck(): Buffer {
  const frame = Buffer.alloc(FRAME_HEADER_SIZE);
  frame.writeUIntBE(0, 0, 3); // length = 0
  frame[3] = FrameType.SETTINGS;
  frame[4] = 0x01; // ACK flag
  frame.writeUInt32BE(0, 5); // stream 0
  return frame;
}

/** Build a raw SETTINGS frame (non-ACK, empty body) */
function buildSettings(): Buffer {
  const frame = Buffer.alloc(FRAME_HEADER_SIZE);
  frame.writeUIntBE(0, 0, 3);
  frame[3] = FrameType.SETTINGS;
  frame[4] = 0;
  frame.writeUInt32BE(0, 5);
  return frame;
}

describe("GOAWAY Frame Handling", () => {
  it("should set goawayReceived and reject new streams after GOAWAY", async () => {
    const { socket } = createMockSocket();
    const conn = new Http2Connection(socket, { settingsTimeout: 5000 });

    // Complete handshake
    await conn.startInitialize();
    socket.emit("data", buildSettings());
    socket.emit("data", buildSettingsAck());
    await conn.waitForReady(5000);

    expect(conn.isReady).toBe(true);

    // Receive GOAWAY
    socket.emit("data", buildGoawayFrame(0, ErrorCode.NO_ERROR));

    // Allow microtask processing
    await new Promise(r => setTimeout(r, 10));

    expect(conn.isReady).toBe(false);
    expect(() => conn.createStream()).toThrow(/GOAWAY/);
  });

  it("should emit goaway event with lastStreamId and errorCode", async () => {
    const { socket } = createMockSocket();
    const conn = new Http2Connection(socket, { settingsTimeout: 5000 });

    await conn.startInitialize();
    socket.emit("data", buildSettings());
    socket.emit("data", buildSettingsAck());
    await conn.waitForReady(5000);

    const goawayHandler = vi.fn();
    conn.on("goaway", goawayHandler);

    socket.emit("data", buildGoawayFrame(3, ErrorCode.ENHANCE_YOUR_CALM));
    await new Promise(r => setTimeout(r, 10));

    expect(goawayHandler).toHaveBeenCalledWith({
      lastStreamId: 3,
      errorCode: ErrorCode.ENHANCE_YOUR_CALM,
    });
  });

  it("should close streams with ID > lastStreamId on GOAWAY", async () => {
    const { socket } = createMockSocket();
    const conn = new Http2Connection(socket, { settingsTimeout: 5000 });

    await conn.startInitialize();
    socket.emit("data", buildSettings());
    socket.emit("data", buildSettingsAck());
    await conn.waitForReady(5000);

    // Create streams 1, 3, 5
    const stream1 = conn.createStream();
    const stream3 = conn.createStream();
    const stream5 = conn.createStream();

    expect(stream1.id).toBe(1);
    expect(stream3.id).toBe(3);
    expect(stream5.id).toBe(5);

    // Open streams so they are in the streams map
    stream1.open();
    stream3.open();
    stream5.open();

    // GOAWAY with lastStreamId=3 → stream 5 should be reset
    socket.emit("data", buildGoawayFrame(3, ErrorCode.NO_ERROR));
    await new Promise(r => setTimeout(r, 10));

    // stream5 state should be closed (RST_STREAM with REFUSED_STREAM)
    expect(stream5.state).toBe("closed");

    // Streams 1 and 3 remain open (ID <= lastStreamId)
    expect(stream1.state).toBe("open");
    expect(stream3.state).toBe("open");
  });

  it("should allow graceful close to send GOAWAY and clean up", async () => {
    const { socket, written } = createMockSocket();
    const conn = new Http2Connection(socket, { settingsTimeout: 5000 });

    await conn.startInitialize();
    socket.emit("data", buildSettings());
    socket.emit("data", buildSettingsAck());
    await conn.waitForReady(5000);

    const stream = conn.createStream();
    stream.open();

    await conn.close();
    // Allow microtask to flush writes
    await new Promise(r => setTimeout(r, 20));

    // Should have sent a GOAWAY frame (check written buffers)
    // GOAWAY might be in a merged buffer, search for the GOAWAY byte pattern
    const allWritten = Buffer.concat(written);
    let foundGoaway = false;
    for (let i = 0; i + FRAME_HEADER_SIZE <= allWritten.length; i++) {
      if (allWritten[i + 3] === FrameType.GOAWAY && allWritten.readUInt32BE(i + 5) === 0) {
        foundGoaway = true;
        break;
      }
    }
    expect(foundGoaway).toBe(true);

    // Socket.end() should be called
    expect(socket.end).toHaveBeenCalled();

    // Connection should not be ready
    expect(conn.isReady).toBe(false);
  });
});
