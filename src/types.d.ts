/** Type declarations for modules without types */

declare module "hpack.js" {
  interface HpackOptions {
    table?: { size?: number };
  }

  interface HeaderEntry {
    name: string;
    value: string;
  }

  interface Compressor {
    write(headers: HeaderEntry[]): void;
    read(): Buffer | null;
    execute(): void;
    on(event: string, listener: (...args: any[]) => void): void;
  }

  interface Decompressor {
    write(data: Buffer): void;
    read(): any;
    execute(): void;
    on(event: string, listener: (...args: any[]) => void): void;
  }

  export const compressor: {
    create(options?: HpackOptions): Compressor;
  };

  export const decompressor: {
    create(options?: HpackOptions): Decompressor;
  };
}
