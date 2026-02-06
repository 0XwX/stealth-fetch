import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { Http2Connection } from "../../../src/http2/connection.js";
import { FrameType, FRAME_HEADER_SIZE } from "../../../src/http2/constants.js";

/**
 * Mock socket that records each socket.write() call.
 * The cb is invoked asynchronously (like real sockets).
 */
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

/** Build a raw SETTINGS frame (non-ACK, empty body) */
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

/** Count frames of a given type in a concatenated buffer */
function countFrames(buf: Buffer, frameType: number): number {
  let count = 0;
  let offset = 0;
  while (offset + FRAME_HEADER_SIZE <= buf.length) {
    const frameLen = buf.readUIntBE(offset, 3);
    if (buf[offset + 3] === frameType) {
      count++;
    }
    offset += FRAME_HEADER_SIZE + frameLen;
  }
  return count;
}

describe("Write Coalescing", () => {
  it("should coalesce SETTINGS + WINDOW_UPDATE into a single write via writeMulti", async () => {
    const { socket, writeCalls } = createMockSocket();
    writeCalls.length = 0;

    const conn = new Http2Connection(socket, { settingsTimeout: 5000 });

    // startInitialize writes:
    //   1. CONNECTION_PREFACE via writeRaw (flushed by microtask as single buffer)
    //   2. SETTINGS + WINDOW_UPDATE via writeMulti (merged into one socket.write)
    await conn.startInitialize();

    // Allow microtask to flush writeRaw queue
    await new Promise(r => setTimeout(r, 20));

    // Expect exactly 2 write() calls, NOT 3:
    //   - If there was no coalescing, we'd see 3 writes (preface, settings, window_update)
    //   - With writeMulti, SETTINGS + WINDOW_UPDATE are merged into 1 write
    expect(writeCalls.length).toBe(2);

    // First write: connection preface "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
    expect(writeCalls[0].toString("ascii")).toBe("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

    // Second write: merged SETTINGS + WINDOW_UPDATE in a single buffer
    const initData = writeCalls[1];
    const settingsCount = countFrames(initData, FrameType.SETTINGS);
    const windowUpdateCount = countFrames(initData, FrameType.WINDOW_UPDATE);
    expect(settingsCount).toBe(1);
    expect(windowUpdateCount).toBe(1);
  });

  it("should flush GOAWAY via writeRaw as a single write", async () => {
    const { socket, writeCalls } = createMockSocket();
    const conn = new Http2Connection(socket, { settingsTimeout: 5000 });

    // Complete handshake
    await conn.startInitialize();
    socket.emit("data", buildSettings());
    socket.emit("data", buildSettingsAck());
    await conn.waitForReady(5000);

    // Clear previous writes (preface + settings + settings-ack response)
    writeCalls.length = 0;

    // close() sends GOAWAY via writeRaw → microtask flush → single write
    await conn.close();
    await new Promise(r => setTimeout(r, 20));

    // Should produce exactly 1 write call containing GOAWAY
    expect(writeCalls.length).toBe(1);

    const allWritten = Buffer.concat(writeCalls);
    const goawayCount = countFrames(allWritten, FrameType.GOAWAY);
    expect(goawayCount).toBe(1);
  });

  it("should merge SETTINGS ACK response from handleSettingsFrame via writeRaw batching", async () => {
    const { socket, writeCalls } = createMockSocket();
    const conn = new Http2Connection(socket, { settingsTimeout: 5000 });

    await conn.startInitialize();
    await new Promise(r => setTimeout(r, 20));

    // Clear initialization writes
    writeCalls.length = 0;

    // Feed peer SETTINGS (non-ACK) — this triggers handleSettingsFrame
    // which internally calls writeRaw(encodeSettings([], true)) to send ACK
    socket.emit("data", buildSettings());

    // Also feed peer SETTINGS ACK to complete handshake
    socket.emit("data", buildSettingsAck());

    await new Promise(r => setTimeout(r, 20));

    // The SETTINGS ACK response should be flushed as a single write
    // (one writeRaw call produces one socket.write after microtask flush)
    expect(writeCalls.length).toBe(1);

    const ackData = writeCalls[0];
    // Verify it's a SETTINGS frame with ACK flag
    expect(ackData[3]).toBe(FrameType.SETTINGS);
    expect(ackData[4] & 0x01).toBe(0x01); // ACK flag
    expect(ackData.readUIntBE(0, 3)).toBe(0); // empty payload for ACK
  });
});
