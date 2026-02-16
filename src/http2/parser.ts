/**
 * HTTP/2 frame parser.
 * Extracts structured frames from a raw binary data stream.
 *
 * State machine:
 *   FRAME_HEAD (wait for 9 bytes) → FRAME_BODY (wait for length bytes) → loop
 */
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { FrameType, FRAME_HEADER_SIZE, DEFAULT_MAX_FRAME_SIZE } from "./constants.js";
import type { Frame } from "./framer.js";

const enum ParserState {
  FRAME_HEAD,
  FRAME_BODY,
}

/**
 * HTTP/2 frame parser. Feed raw data via feed(), receive frames via 'frame' event.
 *
 * Uses manual feeding instead of Transform stream to avoid pipe() compatibility
 * issues in CF Workers.
 */
export class FrameParser extends EventEmitter {
  private state: ParserState = ParserState.FRAME_HEAD;
  private chunks: Buffer[] = [];
  private bufferLength: number = 0;
  private maxFrameSize: number;
  private errored = false;

  // Current frame header being parsed
  private frameLength = 0;
  private frameType: FrameType = 0;
  private frameFlags = 0;
  private frameStreamId = 0;

  constructor(maxFrameSize: number = DEFAULT_MAX_FRAME_SIZE) {
    super();
    this.maxFrameSize = maxFrameSize;
  }

  /** Update max frame size (after receiving SETTINGS) */
  setMaxFrameSize(size: number): void {
    this.maxFrameSize = size;
  }

  /** Feed raw data into the parser */
  feed(data: Buffer | Uint8Array): void {
    if (this.errored) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length === 0) return;

    this.chunks.push(buf);
    this.bufferLength += buf.length;
    this.process();
  }

  private process(): void {
    while (true) {
      if (this.state === ParserState.FRAME_HEAD) {
        if (this.bufferLength < FRAME_HEADER_SIZE) return;

        // Parse 9-byte frame header
        const header = this.read(FRAME_HEADER_SIZE);

        this.frameLength = (header[0] << 16) | (header[1] << 8) | header[2];
        this.frameType = header[3] as FrameType;
        this.frameFlags = header[4];
        this.frameStreamId =
          ((header[5] & 0x7f) << 24) | (header[6] << 16) | (header[7] << 8) | header[8];

        // Validate frame size
        if (this.frameLength > this.maxFrameSize) {
          this.errored = true;
          this.emit(
            "error",
            new Error(`Frame size ${this.frameLength} exceeds maximum ${this.maxFrameSize}`),
          );
          return;
        }

        this.state = ParserState.FRAME_BODY;
      }

      if (this.state === ParserState.FRAME_BODY) {
        if (this.bufferLength < this.frameLength) return;

        const payload = this.read(this.frameLength);

        const frame: Frame = {
          type: this.frameType,
          flags: this.frameFlags,
          streamId: this.frameStreamId,
          payload,
        };

        this.state = ParserState.FRAME_HEAD;
        this.emit("frame", frame);
      }
    }
  }

  /**
   * Consume `size` bytes from the chunks queue.
   * Assumes `this.bufferLength >= size`.
   */
  private read(size: number): Buffer {
    if (size === 0) return Buffer.alloc(0);

    // Optimization: if first chunk has enough data
    if (this.chunks.length > 0 && this.chunks[0].length >= size) {
      const chunk = this.chunks[0];
      // Copy to avoid consumers mutating the original buffer
      const ret = Buffer.from(chunk.subarray(0, size));
      if (chunk.length === size) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(size);
      }
      this.bufferLength -= size;
      return ret;
    }

    // Slow path: spans multiple chunks
    const ret = Buffer.allocUnsafe(size);
    let copied = 0;
    while (copied < size) {
      const chunk = this.chunks[0];
      const remaining = size - copied;
      const len = Math.min(chunk.length, remaining);
      chunk.copy(ret, copied, 0, len);
      copied += len;
      if (len === chunk.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(len);
      }
    }
    this.bufferLength -= size;
    return ret;
  }
}
