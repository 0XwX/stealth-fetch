/**
 * Socket adapter: bridges cloudflare:sockets Web Streams to Node.js Duplex stream.
 * Reference: pg-cloudflare socket adapter pattern.
 */
import { Duplex } from "node:stream";

/** Options for creating a socket adapter */
export interface SocketAdapterOptions {
  hostname: string;
  port: number;
  tls: boolean;
}

/**
 * Wraps a cloudflare:sockets connection as a Node.js Duplex stream.
 *
 * This allows HTTP/1.1 and HTTP/2 protocol implementations built on
 * Node.js streams to work transparently over CF Workers sockets.
 */
export class CloudflareSocketAdapter extends Duplex {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cfSocket: any = null;
  private reading = false;
  private connected = false;

  readonly hostname: string;
  readonly port: number;
  readonly useTls: boolean;

  constructor(options: SocketAdapterOptions) {
    super();
    this.hostname = options.hostname;
    this.port = options.port;
    this.useTls = options.tls;
  }

  /**
   * Establish the underlying cloudflare:sockets connection.
   * Must be called before using the stream.
   * @param signal Optional AbortSignal — if aborted before TCP connects,
   *   the socket is torn down and the signal's reason is thrown.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;

    const { connect } = await import("cloudflare:sockets");

    const address = { hostname: this.hostname, port: this.port };
    console.debug(`[socket] connect(${this.hostname}:${this.port} tls=${this.useTls})`);

    // Use type assertion to work around strict SocketOptions typing
    // that requires allowHalfOpen, which is optional at runtime
    this.cfSocket = this.useTls
      ? connect(address, { secureTransport: "on" } as unknown as SocketOptions)
      : connect(address);
    this.writer = this.cfSocket.writable.getWriter();
    this.reader = this.cfSocket.readable.getReader();

    // Wait for TCP connection to actually establish.
    // Without this, connection failures (e.g. unreachable host) would only
    // surface on the first _write() call instead of failing fast here.
    // 30s timeout guards against silent SYN drops (firewall black-holes)
    // where the OS never gets a RST and opened hangs indefinitely.
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let onSignalAbort: (() => void) | undefined;

    const racePromises: Promise<unknown>[] = [
      this.cfSocket.opened,
      new Promise<never>((_, reject) => {
        connectTimer = setTimeout(
          () => reject(new Error(`TCP connect timeout (${this.hostname}:${this.port})`)),
          30_000,
        );
      }),
    ];
    if (signal) {
      racePromises.push(
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          onSignalAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onSignalAbort, { once: true });
        }),
      );
    }
    try {
      await Promise.race(racePromises);
    } catch (err) {
      // opened failed or timed out or aborted — clean up resources
      this.destroy();
      throw err;
    } finally {
      clearTimeout(connectTimer);
      if (onSignalAbort) signal!.removeEventListener("abort", onSignalAbort);
    }
    this.connected = true;

    // Monitor socket closure
    this.cfSocket.closed
      .then(() => {
        console.debug(`[socket] closed(${this.hostname}:${this.port}) destroyed=${this.destroyed}`);
        this.connected = false;
        if (!this.destroyed) {
          this.push(null);
          this.emit("close");
        }
      })
      .catch((err: Error) => {
        console.debug(
          `[socket] closed-error(${this.hostname}:${this.port}) destroyed=${this.destroyed} err=${err.message}`,
        );
        this.connected = false;
        if (!this.destroyed) {
          this.destroy(err);
        }
      });

    this.emit("connect");
  }

  /**
   * Node.js Duplex _read: pull data from the CF socket's ReadableStream.
   * Starts a read loop that pushes data into the Duplex readable side.
   */
  _read(): void {
    if (this.reading || !this.reader) return;
    this.reading = true;
    this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const reader = this.reader;
    if (!reader) {
      this.reading = false;
      return;
    }

    try {
      while (this.reading) {
        const { done, value } = await reader.read();
        if (done) {
          this.reading = false;
          this.push(null);
          return;
        }
        // Push Uint8Array into Duplex readable side.
        // If push returns false, stop reading until _read is called again.
        if (!this.push(value)) {
          this.reading = false;
          return;
        }
      }
    } catch (err) {
      this.reading = false;
      if (!this.destroyed) {
        this.destroy(err as Error);
      }
    }
  }

  /**
   * Node.js Duplex _write: write data to the CF socket's WritableStream.
   */
  _write(
    chunk: Buffer | Uint8Array,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.writer || !this.connected) {
      callback(new Error("Socket not connected"));
      return;
    }

    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.writer.write(data).then(
      () => callback(),
      (err: Error) => callback(err),
    );
  }

  /**
   * Node.js Duplex _final: signal end of writes.
   */
  _final(callback: (error?: Error | null) => void): void {
    if (this.writer) {
      this.writer.close().then(
        () => callback(),
        (err: Error) => callback(err),
      );
    } else {
      callback();
    }
  }

  /**
   * Node.js Duplex _destroy: clean up all resources.
   * Uses synchronous close() calls to avoid leaving pending promises
   * that can corrupt CF Workers isolate state.
   */
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    console.debug(
      `[socket] _destroy(${this.hostname}:${this.port}) error=${error?.message ?? "none"}`,
    );
    this.reading = false;
    this.connected = false;

    // Fire-and-forget async cleanup — but catch all errors so no unhandled rejections
    if (this.reader) {
      this.reader.cancel().catch(() => {});
      this.reader = null;
    }
    if (this.writer) {
      this.writer.abort().catch(() => {});
      this.writer = null;
    }
    if (this.cfSocket) {
      this.cfSocket.close().catch(() => {});
      this.cfSocket = null;
    }

    callback(error);
  }

  /** Whether the socket is currently connected */
  get isConnected(): boolean {
    return this.connected;
  }
}
