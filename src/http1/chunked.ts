/**
 * HTTP/1.1 chunked transfer encoding decoder.
 * Decodes chunked body data into raw content.
 *
 * Chunked format:
 *   <hex-size>\r\n
 *   <data>\r\n
 *   ...
 *   0\r\n
 *   \r\n
 */
import { Buffer } from "node:buffer";

const enum ChunkedState {
  READ_SIZE,
  READ_DATA,
  READ_DATA_CRLF,
  DONE,
}

/**
 * Stateful chunked transfer encoding decoder.
 * Feed raw data via feed(), collect decoded chunks via getChunks().
 */
export class ChunkedDecoder {
  private state: ChunkedState = ChunkedState.READ_SIZE;
  private buffer: Buffer = Buffer.alloc(0);
  private currentChunkSize = 0;
  private chunks: Buffer[] = [];
  private _done = false;

  /** Whether all chunks have been received (final 0-length chunk) */
  get done(): boolean {
    return this._done;
  }

  /** Feed raw data into the decoder */
  feed(data: Buffer | Uint8Array): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, buf]) : buf;
    this.process();
  }

  /** Get and clear decoded chunks */
  getChunks(): Buffer[] {
    const result = this.chunks;
    this.chunks = [];
    return result;
  }

  private process(): void {
    while (this.buffer.length > 0 && !this._done) {
      switch (this.state) {
        case ChunkedState.READ_SIZE: {
          const crlfIdx = this.findCRLF();
          if (crlfIdx === -1) return; // need more data

          const sizeLine = this.buffer.subarray(0, crlfIdx).toString("ascii");
          // Chunk size may have extensions after ";", ignore them
          const semiIdx = sizeLine.indexOf(";");
          const sizeStr = semiIdx === -1 ? sizeLine : sizeLine.substring(0, semiIdx);
          this.currentChunkSize = parseInt(sizeStr.trim(), 16);

          if (isNaN(this.currentChunkSize) || this.currentChunkSize < 0) {
            throw new Error(`Invalid chunk size: "${sizeStr.trim()}"`);
          }
          if (this.currentChunkSize > 16 * 1024 * 1024) {
            throw new Error(`Chunk size too large: ${this.currentChunkSize}`);
          }

          this.buffer = this.buffer.subarray(crlfIdx + 2);

          if (this.currentChunkSize === 0) {
            this._done = true;
            return;
          }

          this.state = ChunkedState.READ_DATA;
          break;
        }

        case ChunkedState.READ_DATA: {
          if (this.buffer.length < this.currentChunkSize) return; // need more data

          this.chunks.push(this.buffer.subarray(0, this.currentChunkSize));
          this.buffer = this.buffer.subarray(this.currentChunkSize);
          this.state = ChunkedState.READ_DATA_CRLF;
          break;
        }

        case ChunkedState.READ_DATA_CRLF: {
          if (this.buffer.length < 2) return; // need \r\n
          if (this.buffer[0] !== 0x0d || this.buffer[1] !== 0x0a) {
            throw new Error("Expected CRLF after chunk data");
          }
          this.buffer = this.buffer.subarray(2);
          this.state = ChunkedState.READ_SIZE;
          break;
        }

        case ChunkedState.DONE:
          return;
      }
    }
  }

  private findCRLF(): number {
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i] === 0x0d && this.buffer[i + 1] === 0x0a) {
        return i;
      }
    }
    return -1;
  }
}
