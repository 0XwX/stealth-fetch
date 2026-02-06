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
  private buffer: Buffer = Buffer.alloc(0);
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
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, buf]) : buf;
    this.process();
  }

  private process(): void {
    while (true) {
      if (this.state === ParserState.FRAME_HEAD) {
        if (this.buffer.length < FRAME_HEADER_SIZE) return;

        // Parse 9-byte frame header
        this.frameLength = (this.buffer[0] << 16) | (this.buffer[1] << 8) | this.buffer[2];
        this.frameType = this.buffer[3] as FrameType;
        this.frameFlags = this.buffer[4];
        this.frameStreamId =
          ((this.buffer[5] & 0x7f) << 24) |
          (this.buffer[6] << 16) |
          (this.buffer[7] << 8) |
          this.buffer[8];

        // Validate frame size
        if (this.frameLength > this.maxFrameSize) {
          this.errored = true;
          this.emit(
            "error",
            new Error(`Frame size ${this.frameLength} exceeds maximum ${this.maxFrameSize}`),
          );
          return;
        }

        this.buffer = this.buffer.subarray(FRAME_HEADER_SIZE);
        this.state = ParserState.FRAME_BODY;
      }

      if (this.state === ParserState.FRAME_BODY) {
        if (this.buffer.length < this.frameLength) return;

        const payload = this.buffer.subarray(0, this.frameLength);
        this.buffer = this.buffer.subarray(this.frameLength);

        const frame: Frame = {
          type: this.frameType,
          flags: this.frameFlags,
          streamId: this.frameStreamId,
          payload: Buffer.from(payload), // copy to avoid subarray issues
        };

        this.state = ParserState.FRAME_HEAD;
        this.emit("frame", frame);
      }
    }
  }
}
