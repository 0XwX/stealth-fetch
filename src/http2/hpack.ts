/**
 * HPACK header compression wrapper.
 *
 * Uses hpack.js low-level API (encoder/decoder + table) directly,
 * bypassing its Duplex stream wrappers which have ordering issues
 * in CF Workers (cb called before push in _write).
 */
import { Buffer } from "node:buffer";
import { OPTIMIZED_HEADER_TABLE_SIZE } from "./constants.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let hpackModule: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getHpack(): Promise<any> {
  if (!hpackModule) {
    hpackModule = await import("hpack.js");
  }
  return hpackModule;
}

/** Fire-and-forget preload of hpack.js module to avoid lazy-init delay */
export function preloadHpack(): void {
  if (!hpackModule) {
    getHpack().catch(() => {});
  }
}

/**
 * HPACK encoder: compresses header list into binary block.
 * Uses hpack.js encoder + table directly (no stream wrapper).
 */
export class HpackEncoder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private table: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private hpack: any = null;

  constructor(private tableSize: number = OPTIMIZED_HEADER_TABLE_SIZE) {}

  private async ensureInit(): Promise<void> {
    if (this.table) return;
    this.hpack = await getHpack();
    this.table = this.hpack.table.create({ maxSize: this.tableSize });
  }

  async encode(headers: Array<[string, string]>): Promise<Buffer> {
    await this.ensureInit();

    const enc = this.hpack.encoder.create();

    for (const [name, value] of headers) {
      this.encodeHeader(enc, name, value);
    }

    const chunks: Buffer[] = enc.render();
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  }

  /**
   * Headers that should NOT be added to HPACK dynamic table.
   * High-cardinality values waste table space (matches nghttp2 strategy).
   */
  private static readonly NEVER_INDEX = new Set([
    ":path",
    "content-length",
    "content-range",
    "date",
    "last-modified",
    "etag",
    "age",
    "expires",
    "set-cookie",
    "cookie",
    "authorization",
    "proxy-authorization",
    "location",
    "if-modified-since",
    "if-none-match",
  ]);

  /**
   * Sensitive headers that MUST use "Literal never indexed" (0x10 prefix).
   * Instructs intermediaries to never compress/cache these values
   * (RFC 7541 Section 6.2.3).
   */
  private static readonly SENSITIVE = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private encodeHeader(enc: any, name: string, value: string): void {
    const utils = this.hpack.utils;
    const index = this.table.reverseLookup(name, value);
    const isIndexed = index > 0;
    const isIncremental = !HpackEncoder.NEVER_INDEX.has(name);

    enc.encodeBit(isIndexed ? 1 : 0);
    if (isIndexed) {
      enc.encodeInt(index);
      return;
    }

    const nameArr = utils.toArray(name);
    const valueArr = utils.toArray(value);

    enc.encodeBit(isIncremental ? 1 : 0);
    if (isIncremental) {
      this.table.add(name, value, nameArr.length, valueArr.length);
    } else {
      enc.encodeBit(0); // update = false
      enc.encodeBit(HpackEncoder.SENSITIVE.has(name) ? 1 : 0); // neverIndex
    }

    enc.encodeInt(-index);
    if (index === 0) {
      enc.encodeStr(nameArr, true); // huffman = true
    }
    enc.encodeStr(valueArr, true); // huffman = true
  }
}

/**
 * HPACK decoder: decompresses binary block into header list.
 * Uses hpack.js decoder + table directly (no Duplex stream wrapper).
 *
 * The hpack.js Decompressor wraps Duplex from readable-stream, but
 * in CF Workers the readable side doesn't return data synchronously
 * from read() after push(). So we replicate the decode logic directly.
 */
export class HpackDecoder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private table: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private hpack: any = null;

  constructor(private tableSize: number = OPTIMIZED_HEADER_TABLE_SIZE) {}

  private async ensureInit(): Promise<void> {
    if (this.table) return;
    this.hpack = await getHpack();
    this.table = this.hpack.table.create({ maxSize: this.tableSize });
  }

  async decode(block: Buffer): Promise<Array<[string, string]>> {
    await this.ensureInit();

    const dec = this.hpack.decoder.create();
    const utils = this.hpack.utils;
    dec.push(block);

    const headers: Array<[string, string]> = [];
    // RFC 7541 Section 4.2: dynamic table size updates MUST occur at the
    // beginning of the first header block following a size change.
    let seenNonUpdate = false;

    while (!dec.isEmpty()) {
      const isIndexed = dec.decodeBit();
      if (isIndexed) {
        // Indexed header field (RFC 7541 Section 6.1)
        seenNonUpdate = true;
        const index = dec.decodeInt();
        const lookup = this.table.lookup(index);
        headers.push([lookup.name, lookup.value]);
        continue;
      }

      const isIncremental = dec.decodeBit();
      if (!isIncremental) {
        const isUpdate = dec.decodeBit();
        if (isUpdate) {
          // Dynamic table size update (RFC 7541 Section 6.3)
          if (seenNonUpdate) {
            throw new Error(
              "HPACK dynamic table size update must occur at the start of a header block",
            );
          }
          const size = dec.decodeInt();
          if (size > this.tableSize) {
            throw new Error(
              `HPACK dynamic table size update ${size} exceeds limit ${this.tableSize}`,
            );
          }
          this.table.updateSize(size);
          continue;
        }

        // Literal without indexing or never indexed
        seenNonUpdate = true;
        dec.decodeBit(); // neverIndex — we don't use it
        const index = dec.decodeInt();

        let name: string;
        if (index === 0) {
          const nameArr = dec.decodeStr();
          name = utils.stringify(nameArr);
        } else {
          const lookup = this.table.lookup(index);
          name = lookup.name;
        }

        const valueArr = dec.decodeStr();
        const value = utils.stringify(valueArr);

        headers.push([name, value]);
        continue;
      }

      // Literal with incremental indexing (RFC 7541 Section 6.2.1)
      seenNonUpdate = true;
      const index = dec.decodeInt();

      let name: string;
      let nameSize: number;
      if (index === 0) {
        const nameArr = dec.decodeStr();
        nameSize = nameArr.length;
        name = utils.stringify(nameArr);
      } else {
        const lookup = this.table.lookup(index);
        nameSize = lookup.nameSize;
        name = lookup.name;
      }

      const valueArr = dec.decodeStr();
      const valueSize = valueArr.length;
      const value = utils.stringify(valueArr);

      this.table.add(name, value, nameSize, valueSize);
      headers.push([name, value]);
    }

    return headers;
  }
}
