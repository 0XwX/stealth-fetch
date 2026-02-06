/**
 * HTTP/2 frame serializer.
 * Encodes structured frame objects into binary wire format.
 *
 * Frame layout (RFC 7540 Section 4.1):
 *   +-----------------------------------------------+
 *   |                 Length (24)                     |
 *   +---------------+---------------+---------------+
 *   |   Type (8)    |   Flags (8)   |
 *   +-+-------------+---------------+---------+
 *   |R|         Stream Identifier (31)         |
 *   +=+=========================================+
 *   |               Frame Payload                    |
 *   +-----------------------------------------------+
 */
import { Buffer } from "node:buffer";
import { FrameType, FrameFlags, SettingsId, ErrorCode, FRAME_HEADER_SIZE } from "./constants.js";

export interface Frame {
  type: FrameType;
  flags: number;
  streamId: number;
  payload: Buffer;
}

/**
 * Encode a frame into its wire format (9-byte header + payload).
 */
export function encodeFrame(frame: Frame): Buffer {
  const { type, flags, streamId, payload } = frame;
  const buf = Buffer.alloc(FRAME_HEADER_SIZE + payload.length);

  // Length (24 bits, big-endian)
  buf[0] = (payload.length >> 16) & 0xff;
  buf[1] = (payload.length >> 8) & 0xff;
  buf[2] = payload.length & 0xff;

  // Type (8 bits)
  buf[3] = type;

  // Flags (8 bits)
  buf[4] = flags;

  // Stream ID (31 bits, big-endian, R bit = 0)
  buf[5] = (streamId >> 24) & 0x7f;
  buf[6] = (streamId >> 16) & 0xff;
  buf[7] = (streamId >> 8) & 0xff;
  buf[8] = streamId & 0xff;

  // Payload
  payload.copy(buf, FRAME_HEADER_SIZE);

  return buf;
}

/** Pre-allocated SETTINGS ACK frame (9 bytes, content never changes) */
const SETTINGS_ACK_FRAME = (() => {
  const buf = Buffer.alloc(FRAME_HEADER_SIZE);
  buf[3] = FrameType.SETTINGS;
  buf[4] = FrameFlags.ACK;
  return buf;
})();

/** Encode a SETTINGS frame */
export function encodeSettings(settings: Array<[SettingsId, number]>, ack = false): Buffer {
  if (ack) return SETTINGS_ACK_FRAME;

  const payload = Buffer.alloc(settings.length * 6);
  for (let i = 0; i < settings.length; i++) {
    const [id, value] = settings[i];
    const offset = i * 6;
    payload.writeUInt16BE(id, offset);
    payload.writeUInt32BE(value, offset + 2);
  }

  return encodeFrame({
    type: FrameType.SETTINGS,
    flags: 0,
    streamId: 0,
    payload,
  });
}

/** Encode a WINDOW_UPDATE frame (direct construction, no encodeFrame wrapper) */
export function encodeWindowUpdate(streamId: number, increment: number): Buffer {
  const buf = Buffer.alloc(FRAME_HEADER_SIZE + 4);
  buf[2] = 4; // length = 4
  buf[3] = FrameType.WINDOW_UPDATE;
  buf[5] = (streamId >> 24) & 0x7f;
  buf[6] = (streamId >> 16) & 0xff;
  buf[7] = (streamId >> 8) & 0xff;
  buf[8] = streamId & 0xff;
  buf.writeUInt32BE(increment & 0x7fffffff, FRAME_HEADER_SIZE);
  return buf;
}

/** Pre-allocated PING ACK frame header template (9 bytes, type+flags+length fixed) */
const PING_ACK_TEMPLATE = (() => {
  const buf = Buffer.alloc(FRAME_HEADER_SIZE);
  buf[2] = 8; // length = 8
  buf[3] = FrameType.PING;
  buf[4] = FrameFlags.ACK;
  return buf;
})();

/** Encode a PING frame (direct construction, no encodeFrame wrapper) */
export function encodePing(data: Buffer, ack = false): Buffer {
  if (ack) {
    // Fast path: copy pre-allocated header + 8-byte opaque payload
    const buf = Buffer.alloc(FRAME_HEADER_SIZE + 8);
    PING_ACK_TEMPLATE.copy(buf, 0);
    data.copy(buf, FRAME_HEADER_SIZE, 0, Math.min(8, data.length));
    return buf;
  }
  const buf = Buffer.alloc(FRAME_HEADER_SIZE + 8);
  buf[2] = 8; // length = 8
  buf[3] = FrameType.PING;
  data.copy(buf, FRAME_HEADER_SIZE, 0, Math.min(8, data.length));
  return buf;
}

/** Encode a GOAWAY frame */
export function encodeGoaway(
  lastStreamId: number,
  errorCode: ErrorCode,
  debugData?: Buffer,
): Buffer {
  const payload = Buffer.alloc(8 + (debugData?.length ?? 0));
  payload.writeUInt32BE(lastStreamId & 0x7fffffff, 0);
  payload.writeUInt32BE(errorCode, 4);
  if (debugData) {
    debugData.copy(payload, 8);
  }
  return encodeFrame({
    type: FrameType.GOAWAY,
    flags: 0,
    streamId: 0,
    payload,
  });
}

/** Encode a RST_STREAM frame (direct construction, no encodeFrame wrapper) */
export function encodeRstStream(streamId: number, errorCode: ErrorCode): Buffer {
  const buf = Buffer.alloc(FRAME_HEADER_SIZE + 4);
  buf[2] = 4; // length = 4
  buf[3] = FrameType.RST_STREAM;
  buf[5] = (streamId >> 24) & 0x7f;
  buf[6] = (streamId >> 16) & 0xff;
  buf[7] = (streamId >> 8) & 0xff;
  buf[8] = streamId & 0xff;
  buf.writeUInt32BE(errorCode, FRAME_HEADER_SIZE);
  return buf;
}

/** Encode a HEADERS frame */
export function encodeHeaders(
  streamId: number,
  headerBlock: Buffer,
  endStream: boolean,
  endHeaders: boolean,
): Buffer {
  let flags = 0;
  if (endStream) flags |= FrameFlags.END_STREAM;
  if (endHeaders) flags |= FrameFlags.END_HEADERS;

  return encodeFrame({
    type: FrameType.HEADERS,
    flags,
    streamId,
    payload: headerBlock,
  });
}

/** Encode a DATA frame */
export function encodeData(streamId: number, data: Buffer, endStream: boolean): Buffer {
  return encodeFrame({
    type: FrameType.DATA,
    flags: endStream ? FrameFlags.END_STREAM : 0,
    streamId,
    payload: data,
  });
}

/** Encode a CONTINUATION frame */
export function encodeContinuation(
  streamId: number,
  headerBlock: Buffer,
  endHeaders: boolean,
): Buffer {
  return encodeFrame({
    type: FrameType.CONTINUATION,
    flags: endHeaders ? FrameFlags.END_HEADERS : 0,
    streamId,
    payload: headerBlock,
  });
}
