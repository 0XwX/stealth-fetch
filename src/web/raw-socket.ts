/**
 * Minimal socket abstraction over cloudflare:sockets.
 * Uses Web Streams directly — no node:stream Duplex dependency.
 */

export interface RawSocket {
  /** Write data to the socket. */
  write(data: Uint8Array): Promise<void>;
  /** Read the next chunk from the socket. */
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  /** Close the socket and release resources. */
  close(): void;
  /** Whether the socket has been closed. */
  readonly closed: boolean;
}

interface RawSocketOptions {
  hostname: string;
  port: number;
  tls: boolean;
}

/**
 * Create a raw TCP/TLS socket via cloudflare:sockets.
 * Waits for the TCP connection to establish before returning.
 */
export async function createRawSocket(
  options: RawSocketOptions,
  signal?: AbortSignal,
): Promise<RawSocket> {
  if (signal?.aborted) throw signal.reason;

  const { connect } = await import("cloudflare:sockets");

  const address = { hostname: options.hostname, port: options.port };
  console.debug(`[web:socket] connect(${options.hostname}:${options.port} tls=${options.tls})`);

  const cfSocket = options.tls
    ? connect(address, { secureTransport: "on" } as unknown as SocketOptions)
    : connect(address);
  const writer = cfSocket.writable.getWriter();
  const reader = cfSocket.readable.getReader();

  // Wait for TCP connection with 30s timeout + signal support
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let onSignalAbort: (() => void) | undefined;

  const racePromises: Promise<unknown>[] = [
    cfSocket.opened,
    new Promise<never>((_, reject) => {
      connectTimer = setTimeout(
        () => reject(new Error(`TCP connect timeout (${options.hostname}:${options.port})`)),
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
    reader.cancel().catch(() => {});
    writer.abort().catch(() => {});
    cfSocket.close().catch(() => {});
    throw err;
  } finally {
    clearTimeout(connectTimer);
    if (onSignalAbort) signal!.removeEventListener("abort", onSignalAbort);
  }

  let _closed = false;

  cfSocket.closed
    .then(() => {
      _closed = true;
    })
    .catch(() => {
      _closed = true;
    });

  return {
    async write(data: Uint8Array): Promise<void> {
      if (_closed) throw new Error("Socket closed");
      await writer.write(data);
    },
    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      return reader.read();
    },
    close() {
      if (!_closed) {
        _closed = true;
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});
        cfSocket.close().catch(() => {});
      }
    },
    get closed() {
      return _closed;
    },
  };
}
