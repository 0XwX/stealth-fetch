import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { Http2Connection } from "../../../src/http2/connection.js";
import { FrameType, FrameFlags, FRAME_HEADER_SIZE } from "../../../src/http2/constants.js";

/** Mock socket that records writes */
function createMockSocket() {
  const ee = new EventEmitter();
  const writeCalls: Buffer[] = [];

  const socket = Object.assign(ee, {
    write(data: Buffer, cb?: (err?: Error | null) => void) {
      writeCalls.push(Buffer.from(data));
      if (cb) queueMicrotask(() => cb());
    },
    end: vi.fn(),
    destroy: vi.fn(),
  });

  return { socket: socket as any, writeCalls };
}

/** Build a raw SETTINGS frame (non-ACK) */
function buildSettings(): Buffer {
  const frame = Buffer.alloc(FRAME_HEADER_SIZE);
  frame.writeUIntBE(0, 0, 3);
  frame[3] = FrameType.SETTINGS;
  frame[4] = 0;
  frame.writeUInt32BE(0, 5);
  return frame;
}

/** Build a raw SETTINGS ACK frame */
function buildSettingsAck(): Buffer {
  const frame = Buffer.alloc(FRAME_HEADER_SIZE);
  frame.writeUIntBE(0, 0, 3);
  frame[3] = FrameType.SETTINGS;
  frame[4] = 0x01;
  frame.writeUInt32BE(0, 5);
  return frame;
}

/** Parse DATA frames from concatenated buffer */
function parseDataFrames(
  buf: Buffer,
): Array<{ streamId: number; payload: Buffer; endStream: boolean }> {
  const frames: Array<{ streamId: number; payload: Buffer; endStream: boolean }> = [];
  let offset = 0;
  while (offset + FRAME_HEADER_SIZE <= buf.length) {
    const frameLen = buf.readUIntBE(offset, 3);
    const frameType = buf[offset + 3];
    const flags = buf[offset + 4];
    const streamId = buf.readUInt32BE(offset + 5) & 0x7fffffff;

    if (frameType === FrameType.DATA) {
      frames.push({
        streamId,
        payload: buf.subarray(offset + FRAME_HEADER_SIZE, offset + FRAME_HEADER_SIZE + frameLen),
        endStream: (flags & FrameFlags.END_STREAM) !== 0,
      });
    }
    offset += FRAME_HEADER_SIZE + frameLen;
  }
  return frames;
}

/** Complete H2 handshake and create an open stream (bypasses hpack encoding) */
async function setupStream(conn: Http2Connection, socket: any) {
  await conn.startInitialize();
  socket.emit("data", buildSettings());
  socket.emit("data", buildSettingsAck());
  await conn.waitForReady(5000);

  const stream = conn.createStream();
  // Bypass sendHeaders (which triggers hpack.js readable-stream in test env)
  // by directly opening the stream — sendData does not check stream state
  stream.open();
  return stream;
}

describe("sendData with ReadableStream", () => {
  it("should send ReadableStream body as DATA frames with END_STREAM", async () => {
    const { socket, writeCalls } = createMockSocket();
    const conn = new Http2Connection(socket, { settingsTimeout: 5000 });
    const stream = await setupStream(conn, socket);

    // Clear handshake writes
    writeCalls.length = 0;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.enqueue(new TextEncoder().encode(" world"));
        controller.close();
      },
    });

    await conn.sendData(stream, body, true);

    // Allow flush
    await new Promise(r => setTimeout(r, 20));

    const allWritten = Buffer.concat(writeCalls);
    const dataFrames = parseDataFrames(allWritten);

    // Should have at least 2 data frames + 1 END_STREAM frame
    expect(dataFrames.length).toBeGreaterThanOrEqual(2);

    // Check non-END_STREAM data frames contain the body
    const bodyData = Buffer.concat(dataFrames.filter(f => !f.endStream).map(f => f.payload));
    expect(bodyData.toString()).toBe("hello world");

    // Last frame should be END_STREAM (empty DATA with END_STREAM flag)
    const lastFrame = dataFrames[dataFrames.length - 1];
    expect(lastFrame.endStream).toBe(true);
    expect(lastFrame.payload.length).toBe(0);

    // All frames should target stream ID 1
    for (const frame of dataFrames) {
      expect(frame.streamId).toBe(stream.id);
    }
  });

  it("should cancel reader when writeRaw fails", async () => {
    const { socket } = createMockSocket();
    const conn = new Http2Connection(socket, { settingsTimeout: 5000 });
    const stream = await setupStream(conn, socket);

    // Make all subsequent socket.write calls fail
    socket.write = (_data: Buffer, cb?: (err?: Error | null) => void) => {
      if (cb) queueMicrotask(() => cb(new Error("write failed")));
    };

    let cancelCalled = false;
    // Use pull-based stream so the stream is NOT closed before cancel is called.
    // A closed stream's cancel callback won't fire.
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode("data"));
        }
        // Don't close — let cancel terminate the stream
      },
      cancel() {
        cancelCalled = true;
      },
    });

    await expect(conn.sendData(stream, body, true)).rejects.toThrow("write failed");

    // reader.cancel() is async — wait for the cancel callback to propagate
    await new Promise(r => setTimeout(r, 50));
    expect(cancelCalled).toBe(true);
  });

  it("should handle empty ReadableStream (immediate done)", async () => {
    const { socket, writeCalls } = createMockSocket();
    const conn = new Http2Connection(socket, { settingsTimeout: 5000 });
    const stream = await setupStream(conn, socket);

    writeCalls.length = 0;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    await conn.sendData(stream, body, true);
    await new Promise(r => setTimeout(r, 20));

    const allWritten = Buffer.concat(writeCalls);
    const dataFrames = parseDataFrames(allWritten);

    // Should have exactly one empty DATA frame with END_STREAM
    expect(dataFrames.length).toBe(1);
    expect(dataFrames[0].endStream).toBe(true);
    expect(dataFrames[0].payload.length).toBe(0);
  });
});
