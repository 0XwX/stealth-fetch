/**
 * WASM TLS handshake + encrypted session over RawSocket.
 * Pull-based design — no node:stream, no node:events.
 */
import { createRawSocket, type RawSocket } from "./raw-socket.js";
import initWasm, { TlsConnection } from "../socket/wasm-pkg/wasm_tls.js";
import wasmModule from "../socket/wasm-pkg/wasm_tls_bg.wasm";

let wasmInitPromise: Promise<void> | null = null;

function ensureWasmInit(): Promise<void> {
  if (!wasmInitPromise) {
    wasmInitPromise = initWasm(wasmModule).then(
      () => {},
      (err: unknown) => {
        wasmInitPromise = null;
        throw err;
      },
    );
  }
  return wasmInitPromise!;
}

/** Fire-and-forget preload of WASM TLS module. */
export function preloadWasmTls(): void {
  ensureWasmInit().catch(() => {});
}

export interface WasmTlsSocket {
  write(data: Uint8Array): Promise<void>;
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  close(): void;
  readonly closed: boolean;
  readonly negotiatedAlpn: string | null;
}

/**
 * Create a WASM TLS connection: raw TCP + TLS handshake.
 * @param hostname TLS SNI hostname
 * @param port Target port
 * @param alpnProtocols ALPN protocols to negotiate (default: ["http/1.1"])
 * @param connectHostname TCP hostname override (for NAT64)
 * @param signal Abort signal
 */
export async function connectWasmTls(
  hostname: string,
  port: number,
  alpnProtocols: string[] = ["http/1.1"],
  connectHostname?: string,
  signal?: AbortSignal,
): Promise<WasmTlsSocket> {
  await ensureWasmInit();

  // 1. Raw TCP connection (no CF built-in TLS)
  const rawSocket = await createRawSocket(
    { hostname: connectHostname ?? hostname, port, tls: false },
    signal,
  );

  const alpn = alpnProtocols.join(",");
  const tls = new TlsConnection(hostname, alpn);

  try {
    // 2. Send ClientHello
    const clientHello = tls.flush_outgoing_tls();
    if (clientHello.length > 0) {
      await rawSocket.write(clientHello);
    }

    // 3. Handshake loop (pull-based)
    await handshakeLoop(rawSocket, tls, signal);
  } catch (err) {
    tls.free();
    rawSocket.close();
    throw err;
  }

  // 4. Create encrypted session
  return createSession(rawSocket, tls);
}

async function handshakeLoop(
  rawSocket: RawSocket,
  tls: TlsConnection,
  signal?: AbortSignal,
): Promise<void> {
  while (tls.is_handshaking()) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const readResult = await raceSignal(rawSocket.read(), signal);
    if (readResult.done) {
      throw new Error("Connection closed during TLS handshake");
    }

    const needsWrite = tls.feed_ciphertext(readResult.value);
    if (needsWrite) {
      const out = tls.flush_outgoing_tls();
      if (out.length > 0) {
        await rawSocket.write(out);
      }
    }
  }
}

interface Waiter {
  resolve: (result: ReadableStreamReadResult<Uint8Array>) => void;
  reject: (err: unknown) => void;
}

function createSession(rawSocket: RawSocket, tls: TlsConnection): WasmTlsSocket {
  const negotiatedAlpn = tls.negotiated_alpn() ?? null;

  // Plaintext buffer queue with backpressure
  const HIGH_WATER = 64 * 1024; // pause pump when queued bytes exceed this
  const LOW_WATER = 16 * 1024; // resume pump when queued bytes drop below this
  const plaintextQueue: Uint8Array[] = [];
  let queuedBytes = 0;
  let pauseResolve: (() => void) | null = null;
  let waiter: Waiter | null = null;
  let _closed = false;
  let pumpError: Error | null = null;

  function resolveWaiter(result: ReadableStreamReadResult<Uint8Array>): boolean {
    const w = waiter;
    if (w) {
      waiter = null;
      w.resolve(result);
      return true;
    }
    return false;
  }

  function rejectWaiter(err: Error): void {
    const w = waiter;
    if (w) {
      waiter = null;
      w.reject(err);
    }
  }

  function resumePumpIfNeeded(): void {
    if (pauseResolve && queuedBytes < LOW_WATER) {
      const r = pauseResolve;
      pauseResolve = null;
      r();
    }
  }

  // Background pump: read ciphertext → decrypt → enqueue plaintext
  const pumpLoop = (async () => {
    try {
      while (!_closed) {
        const { done, value } = await rawSocket.read();
        if (done) {
          _closed = true;
          resolveWaiter({ done: true, value: undefined });
          return;
        }

        const needsWrite = tls.feed_ciphertext(value);
        const plaintext = tls.take_plaintext();

        if (needsWrite) {
          const out = tls.flush_outgoing_tls();
          if (out.length > 0) {
            await rawSocket.write(out);
          }
        }

        if (plaintext.length > 0) {
          if (!resolveWaiter({ done: false, value: plaintext })) {
            plaintextQueue.push(plaintext);
            queuedBytes += plaintext.byteLength;
            // Backpressure: pause reading from socket when queue is full
            if (queuedBytes >= HIGH_WATER) {
              await new Promise<void>(r => {
                pauseResolve = r;
              });
            }
          }
        }
      }
    } catch (err) {
      _closed = true;
      pumpError = err instanceof Error ? err : new Error(String(err));
      rejectWaiter(pumpError);
    }
  })();
  pumpLoop.catch(() => {}); // prevent unhandled rejection

  return {
    negotiatedAlpn,

    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (pumpError) return Promise.reject(pumpError);
      if (plaintextQueue.length > 0) {
        const data = plaintextQueue.shift()!;
        queuedBytes -= data.byteLength;
        resumePumpIfNeeded();
        return Promise.resolve({ done: false, value: data });
      }
      if (_closed) {
        return Promise.resolve({
          done: true,
          value: undefined,
        } as ReadableStreamReadResult<Uint8Array>);
      }
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },

    async write(data: Uint8Array): Promise<void> {
      if (_closed) throw new Error("TLS session closed");
      const needsWrite = tls.write_plaintext(data);
      if (needsWrite) {
        const out = tls.flush_outgoing_tls();
        if (out.length > 0) {
          await rawSocket.write(out);
        }
      }
    },

    close() {
      if (!_closed) {
        _closed = true;
        // Unblock pump if paused by backpressure
        if (pauseResolve) {
          const r = pauseResolve;
          pauseResolve = null;
          r();
        }
        try {
          tls.send_close_notify();
          const out = tls.flush_outgoing_tls();
          if (out.length > 0) {
            rawSocket.write(out).catch(() => {});
          }
        } catch {
          // ignore close errors
        }
        tls.free();
        rawSocket.close();
        resolveWaiter({ done: true, value: undefined });
      }
    },

    get closed() {
      return _closed;
    },
  };
}

/** Race a promise against an AbortSignal. */
function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      v => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      e => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
