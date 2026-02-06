import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { FrameParser } from "../../../src/http2/parser.js";
import { FrameType, FrameFlags, FRAME_HEADER_SIZE } from "../../../src/http2/constants.js";
import { encodeFrame, type Frame } from "../../../src/http2/framer.js";

describe("HTTP/2 Frame Parser", () => {
  it("should parse a complete frame", () => {
    const parser = new FrameParser();
    const frames: Frame[] = [];
    parser.on("frame", (f: Frame) => frames.push(f));

    const payload = Buffer.from("hello");
    const raw = encodeFrame({
      type: FrameType.DATA,
      flags: FrameFlags.END_STREAM,
      streamId: 1,
      payload,
    });

    parser.feed(raw);

    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe(FrameType.DATA);
    expect(frames[0].flags).toBe(FrameFlags.END_STREAM);
    expect(frames[0].streamId).toBe(1);
    expect(frames[0].payload.toString()).toBe("hello");
  });

  it("should parse multiple frames in a single feed", () => {
    const parser = new FrameParser();
    const frames: Frame[] = [];
    parser.on("frame", (f: Frame) => frames.push(f));

    const frame1 = encodeFrame({
      type: FrameType.SETTINGS,
      flags: 0,
      streamId: 0,
      payload: Buffer.alloc(0),
    });
    const frame2 = encodeFrame({
      type: FrameType.PING,
      flags: 0,
      streamId: 0,
      payload: Buffer.alloc(8),
    });

    parser.feed(Buffer.concat([frame1, frame2]));

    expect(frames.length).toBe(2);
    expect(frames[0].type).toBe(FrameType.SETTINGS);
    expect(frames[1].type).toBe(FrameType.PING);
  });

  it("should handle data arriving in fragments", () => {
    const parser = new FrameParser();
    const frames: Frame[] = [];
    parser.on("frame", (f: Frame) => frames.push(f));

    const payload = Buffer.from("hello world");
    const raw = encodeFrame({
      type: FrameType.DATA,
      flags: 0,
      streamId: 3,
      payload,
    });

    // Feed header partially
    parser.feed(raw.subarray(0, 5));
    expect(frames.length).toBe(0);

    // Feed rest of header + partial payload
    parser.feed(raw.subarray(5, 12));
    expect(frames.length).toBe(0);

    // Feed rest of payload
    parser.feed(raw.subarray(12));
    expect(frames.length).toBe(1);
    expect(frames[0].payload.toString()).toBe("hello world");
  });

  it("should parse frame with empty payload", () => {
    const parser = new FrameParser();
    const frames: Frame[] = [];
    parser.on("frame", (f: Frame) => frames.push(f));

    const raw = encodeFrame({
      type: FrameType.SETTINGS,
      flags: FrameFlags.ACK,
      streamId: 0,
      payload: Buffer.alloc(0),
    });

    parser.feed(raw);

    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe(FrameType.SETTINGS);
    expect(frames[0].flags).toBe(FrameFlags.ACK);
    expect(frames[0].payload.length).toBe(0);
  });

  it("should emit error for oversized frame", () => {
    const parser = new FrameParser(100); // max 100 bytes
    const errors: Error[] = [];
    parser.on("error", (e: Error) => errors.push(e));

    // Manually craft a frame header claiming 200 byte payload
    const header = Buffer.alloc(FRAME_HEADER_SIZE);
    header[0] = 0;
    header[1] = 0;
    header[2] = 200; // length = 200, exceeds max of 100
    header[3] = FrameType.DATA;
    header[4] = 0;
    header.writeUInt32BE(1, 5);

    parser.feed(header);

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("exceeds maximum");
  });

  it("should correctly parse stream ID (31 bits, ignore R bit)", () => {
    const parser = new FrameParser();
    const frames: Frame[] = [];
    parser.on("frame", (f: Frame) => frames.push(f));

    const raw = encodeFrame({
      type: FrameType.WINDOW_UPDATE,
      flags: 0,
      streamId: 0x7fffffff,
      payload: Buffer.alloc(4),
    });

    parser.feed(raw);

    expect(frames.length).toBe(1);
    expect(frames[0].streamId).toBe(0x7fffffff);
  });
});
