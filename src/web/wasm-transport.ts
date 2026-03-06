/**
 * WASM TLS transport adapter — bridges wasm-tls.ts to the WasmTransport interface.
 * Only imported by the full entry (src/web/index.ts), never by lite.
 */
import { connectWasmTls, preloadWasmTls } from "./wasm-tls.js";
import type { WasmTransport } from "./client.js";

export function createWasmTransport(): WasmTransport {
  return {
    preload: () => preloadWasmTls(),
    connect: (hostname, port, alpn, connectHostname, signal) =>
      connectWasmTls(hostname, port, alpn, connectHostname, signal),
  };
}
