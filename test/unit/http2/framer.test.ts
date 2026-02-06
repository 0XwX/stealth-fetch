import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  encodeFrame,
  encodeSettings,
  encodeWindowUpdate,
  encodePing,
  encodeGoaway,
  encodeHeaders,
  encodeData,
  encodeRstStream,
  type Frame,
} from "../../../src/http2/framer.js";
import {
  FrameType,
  FrameFlags,
  SettingsId,
  ErrorCode,
  FRAME_HEADER_SIZE,
} from "../../../src/http2/constants.js";

describe("HTTP/2 Framer", () => {
  describe("encodeFrame", () => {
    it("should encode a frame with correct 9-byte header", () => {
      const payload = Buffer.from("hello");
      const frame: Frame = {
        type: FrameType.DATA,
        flags: 0,
        streamId: 1,
        payload,
      };

      const encoded = encodeFrame(frame);

      // Length (24 bits)
      expect(encoded[0]).toBe(0);
      expect(encoded[1]).toBe(0);
      expect(encoded[2]).toBe(5);

      // Type
      expect(encoded[3]).toBe(FrameType.DATA);

      // Flags
      expect(encoded[4]).toBe(0);

      // Stream ID
      expect(encoded.readUInt32BE(5) & 0x7fffffff).toBe(1);

      // Payload
      expect(encoded.subarray(FRAME_HEADER_SIZE).toString()).toBe("hello");
    });

    it("should encode frame with large stream ID", () => {
      const frame: Frame = {
        type: FrameType.DATA,
        flags: 0,
        streamId: 0x7fffffff,
        payload: Buffer.alloc(0),
      };

      const encoded = encodeFrame(frame);
      expect(encoded.readUInt32BE(5) & 0x7fffffff).toBe(0x7fffffff);
    });
  });

  describe("encodeSettings", () => {
    it("should encode settings frame", () => {
      const encoded = encodeSettings([
        [SettingsId.ENABLE_PUSH, 0],
        [SettingsId.MAX_FRAME_SIZE, 16384],
      ]);

      // 9 byte header + 12 bytes payload (2 settings * 6 bytes)
      expect(encoded.length).toBe(FRAME_HEADER_SIZE + 12);
      expect(encoded[3]).toBe(FrameType.SETTINGS);
      expect(encoded[4]).toBe(0); // no ACK flag
    });

    it("should encode settings ACK (empty payload)", () => {
      const encoded = encodeSettings([], true);

      expect(encoded.length).toBe(FRAME_HEADER_SIZE);
      expect(encoded[3]).toBe(FrameType.SETTINGS);
      expect(encoded[4]).toBe(FrameFlags.ACK);

      // Length should be 0
      expect(encoded[0]).toBe(0);
      expect(encoded[1]).toBe(0);
      expect(encoded[2]).toBe(0);
    });
  });

  describe("encodeWindowUpdate", () => {
    it("should encode window update frame", () => {
      const encoded = encodeWindowUpdate(0, 65535);

      expect(encoded.length).toBe(FRAME_HEADER_SIZE + 4);
      expect(encoded[3]).toBe(FrameType.WINDOW_UPDATE);

      const increment = encoded.readUInt32BE(FRAME_HEADER_SIZE) & 0x7fffffff;
      expect(increment).toBe(65535);
    });

    it("should encode window update for stream", () => {
      const encoded = encodeWindowUpdate(1, 1024);
      const streamId = encoded.readUInt32BE(5) & 0x7fffffff;
      expect(streamId).toBe(1);
    });
  });

  describe("encodePing", () => {
    it("should encode ping frame with 8-byte payload", () => {
      const data = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
      const encoded = encodePing(data);

      expect(encoded.length).toBe(FRAME_HEADER_SIZE + 8);
      expect(encoded[3]).toBe(FrameType.PING);
      expect(encoded[4]).toBe(0); // no ACK
    });

    it("should encode ping ACK", () => {
      const data = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
      const encoded = encodePing(data, true);

      expect(encoded[4]).toBe(FrameFlags.ACK);
    });
  });

  describe("encodeGoaway", () => {
    it("should encode goaway frame", () => {
      const encoded = encodeGoaway(3, ErrorCode.NO_ERROR);

      expect(encoded[3]).toBe(FrameType.GOAWAY);
      // Stream ID should be 0
      expect(encoded.readUInt32BE(5) & 0x7fffffff).toBe(0);

      const lastStreamId = encoded.readUInt32BE(FRAME_HEADER_SIZE) & 0x7fffffff;
      expect(lastStreamId).toBe(3);

      const errorCode = encoded.readUInt32BE(FRAME_HEADER_SIZE + 4);
      expect(errorCode).toBe(ErrorCode.NO_ERROR);
    });
  });

  describe("encodeHeaders", () => {
    it("should encode headers with END_STREAM and END_HEADERS", () => {
      const block = Buffer.from([0x82, 0x86]); // HPACK encoded
      const encoded = encodeHeaders(1, block, true, true);

      expect(encoded[3]).toBe(FrameType.HEADERS);
      expect(encoded[4]).toBe(FrameFlags.END_STREAM | FrameFlags.END_HEADERS);
      expect(encoded.readUInt32BE(5) & 0x7fffffff).toBe(1);
    });

    it("should encode headers without END_STREAM", () => {
      const block = Buffer.from([0x82]);
      const encoded = encodeHeaders(1, block, false, true);

      expect(encoded[4]).toBe(FrameFlags.END_HEADERS);
    });
  });

  describe("encodeData", () => {
    it("should encode data frame with END_STREAM", () => {
      const data = Buffer.from("response body");
      const encoded = encodeData(1, data, true);

      expect(encoded[3]).toBe(FrameType.DATA);
      expect(encoded[4]).toBe(FrameFlags.END_STREAM);
      expect(encoded.subarray(FRAME_HEADER_SIZE).toString()).toBe("response body");
    });
  });

  describe("encodeRstStream", () => {
    it("should encode RST_STREAM frame", () => {
      const encoded = encodeRstStream(1, ErrorCode.CANCEL);

      expect(encoded[3]).toBe(FrameType.RST_STREAM);
      expect(encoded.length).toBe(FRAME_HEADER_SIZE + 4);

      const errorCode = encoded.readUInt32BE(FRAME_HEADER_SIZE);
      expect(errorCode).toBe(ErrorCode.CANCEL);
    });
  });
});
