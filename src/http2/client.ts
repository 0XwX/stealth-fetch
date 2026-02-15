/**
 * HTTP/2 high-level client.
 * Wraps Http2Connection to provide a simple request/response API.
 */
import { Buffer } from "node:buffer";
import { createWasmTLSSocket, createPlainSocket } from "../socket/tls.js";
import { parseUrl, type ParsedUrl } from "../utils/url.js";
import {
  buildPseudoHeaders,
  mergeHeaders,
  validateMethod,
  validatePath,
} from "../utils/headers.js";
import { Http2Connection, type ConnectionOptions } from "./connection.js";
import type { Http2ResponseData } from "./stream.js";

export interface Http2RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | ReadableStream<Uint8Array> | null;
  /** Timeout waiting for response headers (ms) */
  headersTimeout?: number;
  /** Timeout waiting for response body data (idle, ms) */
  bodyTimeout?: number;
}

export interface Http2Response {
  status: number;
  headers: Record<string, string>;
  rawHeaders: Array<[string, string]>;
  protocol: "h2";
  body: ReadableStream<Uint8Array>;
}

/**
 * HTTP/2 client. Manages a single connection and allows multiple requests
 * (via stream multiplexing).
 */
export class Http2Client {
  private connection: Http2Connection;

  private constructor(connection: Http2Connection) {
    this.connection = connection;
  }

  /**
   * Create an Http2Client from an already-initialized Http2Connection.
   * Used by auto-negotiation when the TLS socket is already established.
   */
  static fromConnection(connection: Http2Connection): Http2Client {
    return new Http2Client(connection);
  }

  /**
   * Connect to a server and perform HTTP/2 handshake via WASM TLS (with ALPN).
   * Uses non-blocking SETTINGS: preface is sent immediately, handshake
   * completes in parallel with the first request's header encoding.
   */
  static async connect(
    hostname: string,
    port: number = 443,
    tls: boolean = true,
    options: ConnectionOptions = {},
    connectHostname?: string,
    signal?: AbortSignal,
  ): Promise<Http2Client> {
    const socket = tls
      ? await createWasmTLSSocket(hostname, port, ["h2"], connectHostname, signal)
      : await createPlainSocket(connectHostname ?? hostname, port);

    const connection = new Http2Connection(socket, options);
    await connection.startInitialize();

    return new Http2Client(connection);
  }

  /**
   * Send an HTTP/2 request and return the response.
   */
  async request(
    url: string | ParsedUrl,
    options: Http2RequestOptions = {},
  ): Promise<Http2Response> {
    const parsed = typeof url === "string" ? parseUrl(url) : url;
    const method = options.method ?? "GET";

    validateMethod(method);
    validatePath(parsed.path);

    // Build HTTP/2 headers (pseudo + regular)
    const pseudo = buildPseudoHeaders(method, parsed.hostname, parsed.path, parsed.protocol);
    const allHeaders = mergeHeaders(pseudo, options.headers ?? {});

    // Add content-length for non-stream body
    const isStreamBody = options.body instanceof ReadableStream;
    if (options.body && !isStreamBody && (options.body as Uint8Array).byteLength > 0) {
      const hasContentLength = allHeaders.some(([name]) => name === "content-length");
      if (!hasContentLength) {
        allHeaders.push(["content-length", String((options.body as Uint8Array).byteLength)]);
      }
    }

    // Create stream
    const stream = this.connection.createStream();
    if (options.bodyTimeout !== undefined) {
      stream.setBodyTimeout(options.bodyTimeout);
    }
    const hasBody =
      isStreamBody ||
      (options.body && !isStreamBody && (options.body as Uint8Array).byteLength > 0);

    // Send headers
    await this.connection.sendHeaders(stream, allHeaders, !hasBody);

    // Send body if present
    if (hasBody && options.body) {
      if (isStreamBody) {
        await this.connection.sendData(stream, options.body as ReadableStream<Uint8Array>, true);
      } else {
        await this.connection.sendData(stream, Buffer.from(options.body as Uint8Array), true);
      }
    }

    // Wait for response
    const responseData: Http2ResponseData = await stream.waitForResponse(options.headersTimeout);

    return {
      status: responseData.status,
      headers: responseData.headers,
      rawHeaders: responseData.rawHeaders,
      protocol: "h2",
      body: stream.body,
    };
  }

  /** Whether the connection is still usable */
  get isReady(): boolean {
    return this.connection.isReady;
  }

  /** Number of currently active streams */
  get activeStreamCount(): number {
    return this.connection.activeStreamCount;
  }

  /** Remote peer's MAX_CONCURRENT_STREAMS */
  get maxConcurrentStreams(): number {
    return this.connection.maxConcurrentStreams;
  }

  /** Whether the connection can accept another stream */
  get hasCapacity(): boolean {
    return this.isReady && this.activeStreamCount < this.maxConcurrentStreams;
  }

  /** Register a callback for GOAWAY events */
  onGoaway(callback: () => void): void {
    this.connection.on("goaway", callback);
  }

  /** Remove a GOAWAY callback */
  offGoaway(callback: () => void): void {
    this.connection.removeListener("goaway", callback);
  }

  /** Close the connection */
  async close(): Promise<void> {
    await this.connection.close();
  }
}
