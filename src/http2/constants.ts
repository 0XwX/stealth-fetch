/**
 * HTTP/2 protocol constants (RFC 7540 / RFC 9113).
 */
import { Buffer } from "node:buffer";

/** Frame types (RFC 7540 Section 6) */
export const enum FrameType {
  DATA = 0x00,
  HEADERS = 0x01,
  PRIORITY = 0x02,
  RST_STREAM = 0x03,
  SETTINGS = 0x04,
  PUSH_PROMISE = 0x05,
  PING = 0x06,
  GOAWAY = 0x07,
  WINDOW_UPDATE = 0x08,
  CONTINUATION = 0x09,
}

/** Frame flags */
export const FrameFlags = {
  ACK: 0x01,
  END_STREAM: 0x01, // same bit as ACK, context-dependent
  END_HEADERS: 0x04,
  PADDED: 0x08,
  PRIORITY: 0x20,
} as const;

/** Settings identifiers (RFC 7540 Section 6.5.2) */
export const enum SettingsId {
  HEADER_TABLE_SIZE = 0x01,
  ENABLE_PUSH = 0x02,
  MAX_CONCURRENT_STREAMS = 0x03,
  INITIAL_WINDOW_SIZE = 0x04,
  MAX_FRAME_SIZE = 0x05,
  MAX_HEADER_LIST_SIZE = 0x06,
}

/** Error codes (RFC 7540 Section 7) */
export const enum ErrorCode {
  NO_ERROR = 0x00,
  PROTOCOL_ERROR = 0x01,
  INTERNAL_ERROR = 0x02,
  FLOW_CONTROL_ERROR = 0x03,
  SETTINGS_TIMEOUT = 0x04,
  STREAM_CLOSED = 0x05,
  FRAME_SIZE_ERROR = 0x06,
  REFUSED_STREAM = 0x07,
  CANCEL = 0x08,
  COMPRESSION_ERROR = 0x09,
  CONNECT_ERROR = 0x0a,
  ENHANCE_YOUR_CALM = 0x0b,
  INADEQUATE_SECURITY = 0x0c,
  HTTP_1_1_REQUIRED = 0x0d,
}

/** Frame header size in bytes */
export const FRAME_HEADER_SIZE = 9;

/** Default values */
export const DEFAULT_MAX_FRAME_SIZE = 16384; // 16 KB
export const DEFAULT_HEADER_TABLE_SIZE = 4096; // 4 KB
export const DEFAULT_INITIAL_WINDOW_SIZE = 65535; // 64 KB - 1
export const DEFAULT_MAX_HEADER_LIST_SIZE = 81920; // 80 KB

/** Optimized initial window size for streams (2 MiB, matches hyper) */
export const OPTIMIZED_STREAM_WINDOW_SIZE = 2 * 1024 * 1024;

/** Optimized initial window size for connection (4 MiB, matches Go) */
export const OPTIMIZED_CONNECTION_WINDOW_SIZE = 4 * 1024 * 1024;

/** Optimized receive-side MAX_FRAME_SIZE (64 KB, advertised in SETTINGS to remote) */
export const OPTIMIZED_MAX_FRAME_SIZE = 65536;

/** HPACK dynamic table size — use RFC 7541 default for better compression */
export const OPTIMIZED_HEADER_TABLE_SIZE = 4096; // 4 KB (RFC default)

/** HTTP/2 connection preface (RFC 7540 Section 3.5) */
export const CONNECTION_PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
