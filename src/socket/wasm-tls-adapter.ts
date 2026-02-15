/**
 * WasmTlsSocketAdapter: wraps a WASM TLS session as a Node.js Duplex stream.
 * Interface-compatible with CloudflareSocketAdapter — upper-layer code
 * (Http2Connection, http1Request) works without modification.
 */
import { Duplex } from "node:stream";
import { CloudflareSocketAdapter } from "./adapter.js";
import { performTlsHandshake, type WasmTlsSession } from "./wasm-tls-bridge.js";

export interface WasmTlsSocketOptions {
  hostname: string;
  port: number;
  alpnProtocols?: string[];
  /** Override TCP connection hostname (e.g. NAT64 IPv6), while TLS SNI uses `hostname` */
  connectHostname?: string;
}

export class WasmTlsSocketAdapter extends Duplex {
  private rawSocket: CloudflareSocketAdapter | null = null;
  private tlsSession: WasmTlsSession | null = null;
  private _connected = false;

  readonly hostname: string;
  readonly port: number;
  readonly alpnProtocols: string[];
  /** TCP-level hostname (may differ from TLS SNI hostname for NAT64) */
  readonly connectHostname: string;

  constructor(options: WasmTlsSocketOptions) {
    super();
    this.hostname = options.hostname;
    this.port = options.port;
    this.alpnProtocols = options.alpnProtocols ?? ["h2", "http/1.1"];
    this.connectHostname = options.connectHostname ?? options.hostname;
  }

  /**
   * Establish connection: raw TCP -> WASM TLS handshake -> ready.
   * @param signal Optional AbortSignal to cancel the handshake (prevents resource leaks on timeout)
   */
  async connect(signal?: AbortSignal): Promise<void> {
    // 1. Create raw TCP connection (secureTransport: "off")
    // Use connectHostname for TCP (may be NAT64 IPv6), hostname for TLS SNI
    this.rawSocket = new CloudflareSocketAdapter({
      hostname: this.connectHostname,
      port: this.port,
      tls: false, // Critical: no CF built-in TLS
    });
    await this.rawSocket.connect(signal);

    // 2. Perform TLS handshake via WASM (with signal for abort support)
    this.tlsSession = await performTlsHandshake(
      this.rawSocket,
      {
        hostname: this.hostname,
        alpnProtocols: this.alpnProtocols,
      },
      signal,
    );

    // 3. Wire up callbacks: TLS plaintext -> Duplex readable side
    this.tlsSession.onPlaintext(data => {
      if (!this.destroyed) {
        this.push(data);
      }
    });

    this.tlsSession.onClose(() => {
      this._connected = false;
      if (!this.destroyed) {
        this.push(null);
        this.emit("close");
      }
    });

    this.tlsSession.onError(err => {
      this._connected = false;
      if (!this.destroyed) {
        this.destroy(err);
      }
    });

    this._connected = true;
    this.emit("connect");
  }

  /** Get the negotiated ALPN protocol */
  get negotiatedAlpn(): string | null {
    return this.tlsSession?.negotiatedAlpn ?? null;
  }

  _read(): void {
    // Data is pushed via onPlaintext callback, no active pulling needed
  }

  _write(
    chunk: Buffer | Uint8Array,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.tlsSession || !this._connected) {
      callback(new Error("TLS socket not connected"));
      return;
    }

    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.tlsSession.write(data).then(
      () => callback(),
      (err: Error) => callback(err),
    );
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.tlsSession) {
      this.tlsSession.close();
    }
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this._connected = false;
    if (this.tlsSession) {
      this.tlsSession.close();
      this.tlsSession = null;
    }
    if (this.rawSocket) {
      this.rawSocket.destroy();
      this.rawSocket = null;
    }
    callback(error);
  }

  get isConnected(): boolean {
    return this._connected;
  }
}
