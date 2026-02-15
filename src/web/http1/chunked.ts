/**
 * HTTP/1.1 chunked transfer encoding decoder (Uint8Array version, no node:buffer).
 */
import { concatBytes, decode, indexOfCRLF } from "../bytes.js";

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
  private buffer: Uint8Array = new Uint8Array(0);
  private currentChunkSize = 0;
  private chunks: Uint8Array[] = [];
  private _done = false;

  get done(): boolean {
    return this._done;
  }

  feed(data: Uint8Array): void {
    this.buffer = this.buffer.byteLength > 0 ? concatBytes([this.buffer, data]) : data;
    this.process();
  }

  getChunks(): Uint8Array[] {
    const result = this.chunks;
    this.chunks = [];
    return result;
  }

  private process(): void {
    while (this.buffer.byteLength > 0 && !this._done) {
      switch (this.state) {
        case ChunkedState.READ_SIZE: {
          const crlfIdx = indexOfCRLF(this.buffer);
          if (crlfIdx === -1) return;

          const sizeLine = decode(this.buffer.subarray(0, crlfIdx), "latin1");
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
          if (this.buffer.byteLength < this.currentChunkSize) return;

          this.chunks.push(this.buffer.subarray(0, this.currentChunkSize));
          this.buffer = this.buffer.subarray(this.currentChunkSize);
          this.state = ChunkedState.READ_DATA_CRLF;
          break;
        }

        case ChunkedState.READ_DATA_CRLF: {
          if (this.buffer.byteLength < 2) return;
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
}
