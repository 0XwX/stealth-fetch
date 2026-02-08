/**
 * JS Bridge: connects WASM TLS engine with raw TCP socket.
 * Responsibilities:
 *   1. Load and initialize WASM module
 *   2. Drive TLS handshake state machine (async)
 *   3. Bidirectional data transport: socket <-> WASM <-> upper layer
 */
import { Buffer } from "node:buffer";
import type { CloudflareSocketAdapter } from "./adapter.js";
import initWasm, { TlsConnection } from "./wasm-pkg/wasm_tls.js";
import wasmModule from "./wasm-pkg/wasm_tls_bg.wasm";

let wasmInitPromise: Promise<void> | null = null;

/** Ensure WASM module is initialized (lazy, once, concurrency-safe) */
function ensureWasmInit(): Promise<void> {
  if (!wasmInitPromise) {
    // Note: passing wasmModule directly triggers a deprecation warning from wasm-bindgen,
    // but the object form { module_or_path: wasmModule } causes Worker init failure in CF Workers.
    // The sync form initSync({ module: wasmModule }) also fails. Keep deprecated form for now.
    wasmInitPromise = initWasm(wasmModule).then(
      () => {},
      err => {
        wasmInitPromise = null; // allow retry on failure
        throw err;
      },
    );
  }
  return wasmInitPromise!;
}

/** Fire-and-forget preload of WASM TLS module to avoid lazy-init delay */
export function preloadWasmTls(): void {
  ensureWasmInit().catch(() => {});
}

export interface WasmTlsOptions {
  hostname: string;
  alpnProtocols?: string[]; // default: ["h2", "http/1.1"]
}

export interface WasmTlsSession {
  /** Negotiated ALPN protocol (e.g. "h2", "http/1.1", or null) */
  negotiatedAlpn: string | null;
  /** Write plaintext to TLS layer (encrypts and sends to socket) */
  write(data: Uint8Array): Promise<void>;
  /** Register plaintext data callback */
  onPlaintext(callback: (data: Uint8Array) => void): void;
  /** Register close callback */
  onClose(callback: () => void): void;
  /** Register error callback */
  onError(callback: (err: Error) => void): void;
  /** Close TLS session */
  close(): void;
}

/**
 * Perform TLS handshake over an existing raw TCP socket.
 * The rawSocket must have been created with secureTransport: "off".
 */
export async function performTlsHandshake(
  rawSocket: CloudflareSocketAdapter,
  options: WasmTlsOptions,
  signal?: AbortSignal,
): Promise<WasmTlsSession> {
  await ensureWasmInit();

  const alpn = (options.alpnProtocols ?? ["h2", "http/1.1"]).join(",");
  const tls = new TlsConnection(options.hostname, alpn);

  try {
    // 1. Flush initial ClientHello
    const clientHello = tls.flush_outgoing_tls();
    if (clientHello.length > 0) {
      await writeToSocket(rawSocket, clientHello);
    }

    // 2. Handshake loop (with signal for abort support)
    await handshakeLoop(rawSocket, tls, signal);
  } catch (err) {
    // Free WASM TlsConnection on handshake failure to prevent memory leak
    // (WASM objects are not managed by JS GC)
    tls.free();
    throw err;
  }

  const negotiatedAlpn = tls.negotiated_alpn() ?? null;

  // 3. Create session for data transfer phase
  return createSession(rawSocket, tls, negotiatedAlpn);
}

async function handshakeLoop(
  socket: CloudflareSocketAdapter,
  tls: TlsConnection,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    const onData = async (chunk: Buffer | Uint8Array) => {
      try {
        const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        const needsWrite = tls.feed_ciphertext(data);

        if (needsWrite) {
          const out = tls.flush_outgoing_tls();
          if (out.length > 0) {
            await writeToSocket(socket, out);
          }
        }

        if (!tls.is_handshaking()) {
          if (!settled) {
            settled = true;
            cleanup();
            resolve();
          }
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };

    const onError = (err: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };

    const onAbort = () => {
      if (!settled) {
        settled = true;
        cleanup();
        socket.destroy();
        reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
      }
    };

    // Check if already aborted before starting
    if (signal?.aborted) {
      settled = true;
      socket.destroy();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function createSession(
  socket: CloudflareSocketAdapter,
  tls: TlsConnection,
  negotiatedAlpn: string | null,
): WasmTlsSession {
  let plaintextCallback: ((data: Uint8Array) => void) | null = null;
  let closeCallback: (() => void) | null = null;
  let errorCallback: ((err: Error) => void) | null = null;
  let closed = false;

  // Listen for socket data -> feed to TLS -> produce plaintext
  const onData = async (chunk: Buffer | Uint8Array) => {
    try {
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const needsWrite = tls.feed_ciphertext(data);

      // Extract decrypted plaintext
      const plaintext = tls.take_plaintext();
      if (plaintext.length > 0 && plaintextCallback) {
        plaintextCallback(plaintext);
      }

      // If there's response data to send (e.g., TLS alerts)
      if (needsWrite) {
        const out = tls.flush_outgoing_tls();
        if (out.length > 0) {
          await writeToSocket(socket, out);
        }
      }
    } catch (err) {
      if (errorCallback) {
        errorCallback(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  const onEnd = () => {
    if (!closed) {
      closed = true;
      closeCallback?.();
    }
  };

  const onError = (err: Error) => {
    errorCallback?.(err);
  };

  socket.on("data", onData);
  socket.on("end", onEnd);
  socket.on("error", onError);

  return {
    negotiatedAlpn,

    async write(data: Uint8Array): Promise<void> {
      if (closed) throw new Error("TLS session closed");
      const needsWrite = tls.write_plaintext(data);
      if (needsWrite) {
        const out = tls.flush_outgoing_tls();
        if (out.length > 0) {
          await writeToSocket(socket, out);
        }
      }
    },

    onPlaintext(callback) {
      plaintextCallback = callback;
    },
    onClose(callback) {
      closeCallback = callback;
    },
    onError(callback) {
      errorCallback = callback;
    },

    close() {
      if (!closed) {
        closed = true;
        try {
          tls.send_close_notify();
          const out = tls.flush_outgoing_tls();
          if (out.length > 0) {
            // Fire-and-forget close_notify
            writeToSocket(socket, out).catch(() => {});
          }
        } catch {
          // Ignore close errors
        }
        socket.removeListener("data", onData);
        socket.removeListener("end", onEnd);
        socket.removeListener("error", onError);
        socket.end();
        tls.free();
      }
    },
  };
}

function writeToSocket(socket: CloudflareSocketAdapter, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
