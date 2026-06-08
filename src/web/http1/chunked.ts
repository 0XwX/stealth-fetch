/**
 * HTTP/1.1 chunked transfer encoding decoder (Uint8Array version, no node:buffer).
 */
import { decode } from "../bytes.js";

const enum ChunkedState {
  READ_SIZE,
  READ_DATA,
  READ_DATA_CRLF,
  DONE,
}

const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
const MAX_SIZE_LINE_LENGTH = 8192;

/**
 * Stateful chunked transfer encoding decoder.
 * Feed raw data via feed(), collect decoded chunks via getChunks().
 */
export class ChunkedDecoder {
  private state: ChunkedState = ChunkedState.READ_SIZE;
  private buffers: Uint8Array[] = [];
  private bufferOffset = 0;
  private bufferedBytes = 0;
  private sizeLineBytes: number[] = [];
  private sawSizeLineCR = false;
  private currentChunkRemaining = 0;
  private dataCrlfBytesRead = 0;
  private chunks: Uint8Array[] = [];
  private _done = false;

  get done(): boolean {
    return this._done;
  }

  feed(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    this.buffers.push(data);
    this.bufferedBytes += data.byteLength;
    this.process();
  }

  getChunks(): Uint8Array[] {
    const result = this.chunks;
    this.chunks = [];
    return result;
  }

  private process(): void {
    while (this.bufferedBytes > 0 && !this._done) {
      switch (this.state) {
        case ChunkedState.READ_SIZE: {
          if (!this.readSizeLine()) return;
          break;
        }

        case ChunkedState.READ_DATA: {
          while (this.currentChunkRemaining > 0 && this.bufferedBytes > 0) {
            const chunk = this.takeBytes(Math.min(this.currentChunkRemaining, this.bufferedBytes));
            this.currentChunkRemaining -= chunk.byteLength;
            this.chunks.push(chunk);
          }
          if (this.currentChunkRemaining > 0) return;
          this.state = ChunkedState.READ_DATA_CRLF;
          this.dataCrlfBytesRead = 0;
          break;
        }

        case ChunkedState.READ_DATA_CRLF: {
          if (!this.readDataCRLF()) return;
          break;
        }

        case ChunkedState.DONE:
          return;
      }
    }
  }

  private readSizeLine(): boolean {
    while (this.bufferedBytes > 0) {
      const byte = this.takeByte();
      if (this.sawSizeLineCR) {
        if (byte !== 0x0a) {
          throw new Error("Expected LF after chunk size CR");
        }
        this.sawSizeLineCR = false;
        this.parseSizeLine();
        return true;
      }
      if (byte === 0x0d) {
        this.sawSizeLineCR = true;
        continue;
      }
      this.sizeLineBytes.push(byte);
      if (this.sizeLineBytes.length > MAX_SIZE_LINE_LENGTH) {
        throw new Error("Chunk size line too large");
      }
    }
    return false;
  }

  private parseSizeLine(): void {
    const sizeLine = decode(Uint8Array.from(this.sizeLineBytes), "latin1");
    this.sizeLineBytes = [];
    const semiIdx = sizeLine.indexOf(";");
    const sizeStr = (semiIdx === -1 ? sizeLine : sizeLine.substring(0, semiIdx)).trim();

    if (!/^[0-9a-fA-F]+$/.test(sizeStr)) {
      throw new Error(`Invalid chunk size: "${sizeStr}"`);
    }
    const chunkSize = parseInt(sizeStr, 16);
    if (chunkSize > MAX_CHUNK_SIZE) {
      throw new Error(`Chunk size too large: ${chunkSize}`);
    }
    if (chunkSize === 0) {
      this._done = true;
      this.state = ChunkedState.DONE;
      return;
    }
    this.currentChunkRemaining = chunkSize;
    this.state = ChunkedState.READ_DATA;
  }

  private readDataCRLF(): boolean {
    while (this.dataCrlfBytesRead < 2 && this.bufferedBytes > 0) {
      const expected = this.dataCrlfBytesRead === 0 ? 0x0d : 0x0a;
      if (this.takeByte() !== expected) {
        throw new Error("Expected CRLF after chunk data");
      }
      this.dataCrlfBytesRead++;
    }
    if (this.dataCrlfBytesRead < 2) return false;
    this.state = ChunkedState.READ_SIZE;
    return true;
  }

  private takeByte(): number {
    const head = this.buffers[0]!;
    const byte = head[this.bufferOffset++];
    this.bufferedBytes--;
    if (this.bufferOffset === head.byteLength) {
      this.buffers.shift();
      this.bufferOffset = 0;
    }
    return byte;
  }

  private takeBytes(length: number): Uint8Array {
    const head = this.buffers[0]!;
    const available = head.byteLength - this.bufferOffset;
    const take = Math.min(length, available);
    const chunk = head.subarray(this.bufferOffset, this.bufferOffset + take);
    this.bufferOffset += take;
    this.bufferedBytes -= take;
    if (this.bufferOffset === head.byteLength) {
      this.buffers.shift();
      this.bufferOffset = 0;
    }
    return chunk;
  }
}
