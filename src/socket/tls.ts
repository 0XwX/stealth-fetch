/**
 * TLS/TCP connection factory functions.
 * Creates CloudflareSocketAdapter instances with appropriate TLS settings.
 */
import { CloudflareSocketAdapter } from "./adapter.js";
import { WasmTlsSocketAdapter } from "./wasm-tls-adapter.js";

/** Create a TLS-encrypted socket connection (using CF built-in TLS, no ALPN control) */
export async function createTLSSocket(
  hostname: string,
  port: number = 443,
): Promise<CloudflareSocketAdapter> {
  const socket = new CloudflareSocketAdapter({ hostname, port, tls: true });
  await socket.connect();
  return socket;
}

/** Create a plain TCP socket connection (no TLS) */
export async function createPlainSocket(
  hostname: string,
  port: number = 80,
): Promise<CloudflareSocketAdapter> {
  const socket = new CloudflareSocketAdapter({ hostname, port, tls: false });
  await socket.connect();
  return socket;
}

/** Create a socket with auto TLS based on port/protocol */
export async function createSocket(
  hostname: string,
  port: number,
  tls: boolean,
): Promise<CloudflareSocketAdapter> {
  const socket = new CloudflareSocketAdapter({ hostname, port, tls });
  await socket.connect();
  return socket;
}

/**
 * Create a WASM TLS socket with full ALPN control.
 * Uses raw TCP (secureTransport: "off") + rustls in WASM for TLS.
 * This allows ALPN negotiation (required for HTTP/2 over TLS).
 * @param hostname - Target hostname (used for TLS SNI)
 * @param port - Target port
 * @param alpnProtocols - ALPN protocol list
 * @param connectHostname - Optional override for TCP connection hostname
 *   (e.g. NAT64 IPv6 address). TLS SNI will still use `hostname`.
 */
export async function createWasmTLSSocket(
  hostname: string,
  port: number = 443,
  alpnProtocols: string[] = ["h2", "http/1.1"],
  connectHostname?: string,
): Promise<WasmTlsSocketAdapter> {
  const socket = new WasmTlsSocketAdapter({
    hostname,
    port,
    alpnProtocols,
    connectHostname,
  });
  await socket.connect();
  return socket;
}
