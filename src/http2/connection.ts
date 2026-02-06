/**
 * HTTP/2 connection management.
 * Handles the full lifecycle: preface, SETTINGS exchange, frame dispatch,
 * stream creation, and graceful shutdown.
 */
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import {
  FrameType,
  FrameFlags,
  SettingsId,
  ErrorCode,
  CONNECTION_PREFACE,
  DEFAULT_INITIAL_WINDOW_SIZE,
  DEFAULT_MAX_FRAME_SIZE,
  DEFAULT_MAX_HEADER_LIST_SIZE,
  OPTIMIZED_MAX_FRAME_SIZE,
  OPTIMIZED_HEADER_TABLE_SIZE,
  OPTIMIZED_STREAM_WINDOW_SIZE,
  OPTIMIZED_CONNECTION_WINDOW_SIZE,
} from "./constants.js";
import {
  encodeSettings,
  encodeWindowUpdate,
  encodePing,
  encodeGoaway,
  encodeHeaders,
  encodeData,
  encodeRstStream,
  encodeContinuation,
} from "./framer.js";
import type { Frame } from "./framer.js";
import { FrameParser } from "./parser.js";
import { HpackEncoder, HpackDecoder } from "./hpack.js";
import { FlowControlWindow } from "./flow-control.js";
import { Http2Stream } from "./stream.js";

export interface ConnectionOptions {
  /** Maximum header table size for HPACK (default: 1024 to save CPU) */
  headerTableSize?: number;
  /** Initial stream window size for flow control (default: 2 MiB) */
  initialWindowSize?: number;
  /** Connection-level receive window size (default: 4 MiB) */
  connectionWindowSize?: number;
  /** Timeout for SETTINGS exchange in ms (default: 5000) */
  settingsTimeout?: number;
}

/**
 * HTTP/2 connection over a raw socket.
 * Call initialize() after construction to perform the h2 handshake.
 */
export class Http2Connection extends EventEmitter {
  private socket: Duplex;
  private parser: FrameParser;
  private hpackEncoder: HpackEncoder;
  private hpackDecoder: HpackDecoder;

  // Connection state
  private remoteSettings = new Map<SettingsId, number>();
  private localSettings = new Map<SettingsId, number>();
  private nextStreamId = 1; // client uses odd IDs
  private streams = new Map<number, Http2Stream>();
  private connectionSendWindow: FlowControlWindow;
  private connectionRecvWindowSize: number;
  private connectionRecvWindowConsumed = 0;
  private goawayReceived = false;
  private goawaySent = false;
  private initialized = false;
  private closed = false;
  private lastRemoteInitialWindowSize = DEFAULT_INITIAL_WINDOW_SIZE;

  // Write coalescing
  private pendingWrites: Buffer[] = [];
  private flushScheduled = false;
  private flushPromiseResolvers: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  // Settings exchange
  private settingsAckResolve: (() => void) | null = null;
  private remoteSettingsResolve: (() => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private settingsTimeout: number;

  // Continuation state
  private continuationStreamId: number | null = null;
  private continuationBuffer: Buffer[] = [];
  private continuationBufferSize = 0;
  private continuationEndStream = false;

  constructor(socket: Duplex, options: ConnectionOptions = {}) {
    super();
    this.socket = socket;
    this.parser = new FrameParser(OPTIMIZED_MAX_FRAME_SIZE);
    this.connectionSendWindow = new FlowControlWindow(DEFAULT_INITIAL_WINDOW_SIZE);
    this.connectionRecvWindowSize =
      options.connectionWindowSize ?? OPTIMIZED_CONNECTION_WINDOW_SIZE;
    this.settingsTimeout = options.settingsTimeout ?? 5000;

    const tableSize = options.headerTableSize ?? OPTIMIZED_HEADER_TABLE_SIZE;
    this.hpackEncoder = new HpackEncoder(tableSize);
    this.hpackDecoder = new HpackDecoder(tableSize);

    // Set local settings (advertised to remote peer)
    this.localSettings.set(SettingsId.ENABLE_PUSH, 0);
    this.localSettings.set(
      SettingsId.INITIAL_WINDOW_SIZE,
      options.initialWindowSize ?? OPTIMIZED_STREAM_WINDOW_SIZE,
    );
    // Advertise 64KB receive-side MAX_FRAME_SIZE; send-side uses remote's setting (default 16KB)
    this.localSettings.set(SettingsId.MAX_FRAME_SIZE, OPTIMIZED_MAX_FRAME_SIZE);
    this.localSettings.set(SettingsId.HEADER_TABLE_SIZE, tableSize);

    // Wire up parser
    this.parser.on("frame", (frame: Frame) => this.handleFrame(frame));
    this.parser.on("error", (err: Error) => this.handleError(err));

    // Wire up socket data to parser
    this.socket.on("data", (chunk: Buffer | Uint8Array) => {
      this.parser.feed(chunk);
    });
    this.socket.on("error", (err: Error) => this.handleError(err));
    this.socket.on("close", () => this.handleSocketClose());
  }

  /**
   * Initialize the HTTP/2 connection.
   * Sends connection preface + SETTINGS, waits for peer SETTINGS + ACK.
   */
  async initialize(timeout = 5000): Promise<void> {
    await this.startInitialize();
    await this.waitForReady(timeout);
  }

  /**
   * Non-blocking initialization: sends connection preface + SETTINGS
   * immediately without waiting for the peer's response.
   * Call waitForReady() before sending the first request.
   */
  async startInitialize(): Promise<void> {
    // 1. Send connection preface
    await this.writeRaw(CONNECTION_PREFACE);

    // 2. Send initial SETTINGS + connection-level WINDOW_UPDATE (coalesced)
    const settings: Array<[SettingsId, number]> = [];
    for (const [id, value] of this.localSettings) {
      settings.push([id, value]);
    }
    const initFrames: Buffer[] = [encodeSettings(settings)];
    const connectionWindowDelta = this.connectionRecvWindowSize - DEFAULT_INITIAL_WINDOW_SIZE;
    if (connectionWindowDelta > 0) {
      initFrames.push(encodeWindowUpdate(0, connectionWindowDelta));
    }
    await this.writeMulti(initFrames);

    // 3. Set up promises for peer SETTINGS + ACK (resolved later by handleSettingsFrame)
    const remoteSettingsPromise = new Promise<void>(resolve => {
      this.remoteSettingsResolve = resolve;
    });
    const settingsAckPromise = new Promise<void>(resolve => {
      this.settingsAckResolve = resolve;
    });
    this.readyPromise = Promise.all([remoteSettingsPromise, settingsAckPromise]).then(() => {});
  }

  /**
   * Wait for the peer's SETTINGS + ACK to complete the handshake.
   * Must be called after startInitialize().
   */
  async waitForReady(timeout = 5000): Promise<void> {
    if (this.initialized) return;
    if (!this.readyPromise) {
      throw new Error("startInitialize() must be called first");
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("HTTP/2 SETTINGS exchange timeout")), timeout);
    });

    await Promise.race([this.readyPromise, timeoutPromise]);
    this.initialized = true;
  }

  /**
   * Create a new HTTP/2 stream for a request.
   */
  createStream(): Http2Stream {
    if (this.goawayReceived || this.closed) {
      throw new Error("Connection is closed or received GOAWAY");
    }

    // Stream IDs are 31-bit (RFC 7540 Section 5.1.1)
    if (this.nextStreamId > 0x7fffffff) {
      throw new Error("Stream ID space exhausted");
    }

    // Enforce MAX_CONCURRENT_STREAMS (RFC 7540 Section 5.1.2)
    const maxStreams = this.maxConcurrentStreams;
    if (this.streams.size >= maxStreams) {
      throw new Error(`MAX_CONCURRENT_STREAMS limit reached (${maxStreams})`);
    }

    const streamId = this.nextStreamId;
    this.nextStreamId += 2; // client uses odd IDs

    const initialSendWindowSize =
      this.remoteSettings.get(SettingsId.INITIAL_WINDOW_SIZE) ?? DEFAULT_INITIAL_WINDOW_SIZE;
    const recvWindowSize =
      this.localSettings.get(SettingsId.INITIAL_WINDOW_SIZE) ?? OPTIMIZED_STREAM_WINDOW_SIZE;
    const stream = new Http2Stream(streamId, initialSendWindowSize, recvWindowSize);
    this.streams.set(streamId, stream);

    // Send RST_STREAM(CANCEL) when body is cancelled by consumer
    stream.setOnBodyCancel(id => {
      if (this.streams.has(id) && !this.closed) {
        this.writeRaw(encodeRstStream(id, ErrorCode.CANCEL)).catch(() => {});
        stream.handleRstStream(ErrorCode.CANCEL);
      }
    });

    // Allow stream to request RST_STREAM without altering local state
    stream.setOnSendRst((id, code) => {
      if (this.streams.has(id) && !this.closed) {
        this.writeRaw(encodeRstStream(id, code)).catch(() => {});
      }
    });

    stream.on("close", () => {
      this.streams.delete(streamId);
    });

    return stream;
  }

  /**
   * Send HEADERS frame for a stream.
   * Handles CONTINUATION if header block exceeds max frame size.
   * Auto-waits for SETTINGS exchange if not yet complete.
   */
  async sendHeaders(
    stream: Http2Stream,
    headers: Array<[string, string]>,
    endStream: boolean,
  ): Promise<void> {
    // RFC 7540 Section 5.1: cannot send on half-closed(local) or closed stream
    if (stream.state === "half-closed-local" || stream.state === "closed") {
      throw new Error(`Cannot send HEADERS on stream in state: ${stream.state}`);
    }

    // Encode headers in parallel with SETTINGS exchange
    const [headerBlock] = await Promise.all([
      this.hpackEncoder.encode(headers),
      this.initialized ? Promise.resolve() : this.waitForReady(this.settingsTimeout),
    ]);
    const maxPayload = this.remoteSettings.get(SettingsId.MAX_FRAME_SIZE) ?? DEFAULT_MAX_FRAME_SIZE;

    if (headerBlock.length <= maxPayload) {
      // Fits in one HEADERS frame
      await this.writeRaw(encodeHeaders(stream.id, headerBlock, endStream, true));
    } else {
      // Need CONTINUATION frames — send atomically via writeMulti to prevent
      // interleaving with other streams (RFC 7540 Section 4.3)
      const frames: Buffer[] = [];
      const firstChunk = headerBlock.subarray(0, maxPayload);
      frames.push(encodeHeaders(stream.id, firstChunk, endStream, false));

      let offset = maxPayload;
      while (offset < headerBlock.length) {
        const remaining = headerBlock.length - offset;
        const chunkSize = Math.min(remaining, maxPayload);
        const chunk = headerBlock.subarray(offset, offset + chunkSize);
        const endHeaders = offset + chunkSize >= headerBlock.length;
        frames.push(encodeContinuation(stream.id, chunk, endHeaders));
        offset += chunkSize;
      }
      await this.writeMulti(frames);
    }

    stream.open();
    if (endStream) {
      stream.halfCloseLocal();
    }
  }

  /**
   * Send DATA frame(s) for a stream, respecting flow control.
   * Accepts Buffer (buffered) or ReadableStream (streaming).
   */
  async sendData(
    stream: Http2Stream,
    data: Buffer | ReadableStream<Uint8Array>,
    endStream: boolean,
  ): Promise<void> {
    // RFC 7540 Section 5.1: cannot send on half-closed(local) or closed stream
    if (stream.state === "half-closed-local" || stream.state === "closed") {
      throw new Error(`Cannot send DATA on stream in state: ${stream.state}`);
    }

    if (data instanceof ReadableStream) {
      return this.sendStreamData(stream, data, endStream);
    }
    return this.sendBufferData(stream, data, endStream);
  }

  private async sendBufferData(
    stream: Http2Stream,
    data: Buffer,
    endStream: boolean,
  ): Promise<void> {
    const maxPayload = this.remoteSettings.get(SettingsId.MAX_FRAME_SIZE) ?? DEFAULT_MAX_FRAME_SIZE;

    let offset = 0;
    while (offset < data.length) {
      const remaining = data.length - offset;
      const chunkSize = Math.min(remaining, maxPayload);

      // Wait for both connection and stream flow control windows
      try {
        await this.connectionSendWindow.consume(chunkSize);
        await stream.sendWindow.consume(chunkSize);
      } catch (err) {
        // Flow control cancelled — stream or connection closed
        if ((err as Error).message?.includes("cancelled")) return;
        throw err;
      }

      const chunk = data.subarray(offset, offset + chunkSize);
      const isLast = offset + chunkSize >= data.length;
      await this.writeRaw(encodeData(stream.id, chunk, isLast && endStream));
      offset += chunkSize;
    }

    // Handle empty body with endStream
    if (data.length === 0 && endStream) {
      await this.writeRaw(encodeData(stream.id, Buffer.alloc(0), true));
    }

    if (endStream) {
      stream.halfCloseLocal();
    }
  }

  /** Stream a ReadableStream body as DATA frames with flow control (pull model). */
  private async sendStreamData(
    stream: Http2Stream,
    body: ReadableStream<Uint8Array>,
    endStream: boolean,
  ): Promise<void> {
    const maxPayload = this.remoteSettings.get(SettingsId.MAX_FRAME_SIZE) ?? DEFAULT_MAX_FRAME_SIZE;
    const reader = body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Split each chunk by MAX_FRAME_SIZE, respecting flow control
        const buf = Buffer.from(value);
        let offset = 0;
        while (offset < buf.length) {
          const size = Math.min(buf.length - offset, maxPayload);
          try {
            await this.connectionSendWindow.consume(size);
            await stream.sendWindow.consume(size);
          } catch (err) {
            if ((err as Error).message?.includes("cancelled")) {
              reader.cancel().catch(() => {});
              return;
            }
            throw err;
          }
          const slice = buf.subarray(offset, offset + size);
          await this.writeRaw(encodeData(stream.id, slice, false));
          offset += size;
        }
      }
    } catch (err) {
      reader.cancel(err as Error).catch(() => {});
      throw err;
    } finally {
      reader.releaseLock();
    }

    // Send END_STREAM
    if (endStream) {
      await this.writeRaw(encodeData(stream.id, Buffer.alloc(0), true));
      stream.halfCloseLocal();
    }
  }

  /**
   * Gracefully close the connection.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const lastStreamId = Math.max(0, this.nextStreamId - 2);
    await this.writeRaw(encodeGoaway(lastStreamId, ErrorCode.NO_ERROR)).catch(() => {});

    // Cancel all pending streams
    for (const stream of this.streams.values()) {
      stream.handleRstStream(ErrorCode.CANCEL);
    }
    this.streams.clear();
    this.connectionSendWindow.cancel();

    this.socket.end();
  }

  // --- Frame dispatch ---

  private handleFrame(frame: Frame): void {
    // Handle CONTINUATION state
    if (this.continuationStreamId !== null) {
      if (frame.type !== FrameType.CONTINUATION || frame.streamId !== this.continuationStreamId) {
        this.sendGoawayAndClose(ErrorCode.PROTOCOL_ERROR);
        return;
      }
      this.continuationBufferSize += frame.payload.length;
      if (this.continuationBufferSize > DEFAULT_MAX_HEADER_LIST_SIZE) {
        // CONTINUATION flood protection (CVE-2024-27983)
        this.continuationStreamId = null;
        this.continuationBuffer = [];
        this.continuationBufferSize = 0;
        this.sendGoawayAndClose(ErrorCode.ENHANCE_YOUR_CALM);
        return;
      }
      this.continuationBuffer.push(frame.payload);
      if (frame.flags & FrameFlags.END_HEADERS) {
        const fullBlock = Buffer.concat(this.continuationBuffer);
        const streamId = this.continuationStreamId;
        const endStream = this.continuationEndStream;
        this.continuationStreamId = null;
        this.continuationBuffer = [];
        this.continuationBufferSize = 0;
        this.continuationEndStream = false;
        this.processHeaderBlock(streamId, fullBlock, endStream);
      }
      return;
    }

    switch (frame.type) {
      case FrameType.DATA:
        this.handleDataFrame(frame);
        break;
      case FrameType.HEADERS:
        this.handleHeadersFrame(frame);
        break;
      case FrameType.SETTINGS:
        this.handleSettingsFrame(frame);
        break;
      case FrameType.WINDOW_UPDATE:
        this.handleWindowUpdateFrame(frame);
        break;
      case FrameType.PING:
        this.handlePingFrame(frame);
        break;
      case FrameType.GOAWAY:
        this.handleGoawayFrame(frame);
        break;
      case FrameType.RST_STREAM:
        this.handleRstStreamFrame(frame);
        break;
      case FrameType.PUSH_PROMISE:
        // We disabled PUSH, send PROTOCOL_ERROR if received
        this.writeRaw(encodeGoaway(0, ErrorCode.PROTOCOL_ERROR)).catch(() => {});
        break;
      default:
        // Unknown frame types are ignored (RFC 7540 Section 4.1)
        break;
    }
  }

  private handleDataFrame(frame: Frame): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;

    // DATA on half-closed (remote) or closed stream is a stream error (RFC 7540 Section 5.1)
    if (stream.state === "half-closed-remote" || stream.state === "closed") {
      this.writeRaw(encodeRstStream(frame.streamId, ErrorCode.STREAM_CLOSED)).catch(() => {});
      return;
    }

    const endStream = !!(frame.flags & FrameFlags.END_STREAM);

    // Strip PADDED field (RFC 7540 Section 6.1)
    let payload = frame.payload;
    if (frame.flags & FrameFlags.PADDED) {
      if (payload.length < 1) {
        this.sendGoawayAndClose(ErrorCode.PROTOCOL_ERROR);
        return;
      }
      const padLength = payload[0];
      if (padLength >= payload.length) {
        this.sendGoawayAndClose(ErrorCode.PROTOCOL_ERROR);
        return;
      }
      payload = payload.subarray(1, payload.length - padLength);
    }

    stream.handleData(payload, endStream);

    // Threshold-based WINDOW_UPDATE (matches nghttp2/h2-rust strategy)
    if (frame.payload.length > 0) {
      this.connectionRecvWindowConsumed += frame.payload.length;
      stream.recvWindowConsumed += frame.payload.length;

      const updates: Buffer[] = [];

      // Connection-level: send when consumed >= half of window
      if (this.connectionRecvWindowConsumed >= this.connectionRecvWindowSize >>> 1) {
        updates.push(encodeWindowUpdate(0, this.connectionRecvWindowConsumed));
        this.connectionRecvWindowConsumed = 0;
      }

      // Stream-level: send when consumed >= half of window (skip if stream ending)
      if (!endStream && stream.recvWindowConsumed >= stream.recvWindowSize >>> 1) {
        updates.push(encodeWindowUpdate(frame.streamId, stream.recvWindowConsumed));
        stream.recvWindowConsumed = 0;
      }

      if (updates.length > 0) {
        this.writeMulti(updates).catch(() => {});
      }
    }
  }

  private handleHeadersFrame(frame: Frame): void {
    const endHeaders = !!(frame.flags & FrameFlags.END_HEADERS);
    const endStream = !!(frame.flags & FrameFlags.END_STREAM);

    // Strip PADDED and PRIORITY fields (RFC 7540 Section 6.2)
    let payload = frame.payload;
    let offset = 0;

    if (frame.flags & FrameFlags.PADDED) {
      if (payload.length < 1) {
        this.sendGoawayAndClose(ErrorCode.PROTOCOL_ERROR);
        return;
      }
      const padLength = payload[0];
      offset = 1;
      // Validate: padLength must not exceed remaining payload
      if (padLength > payload.length - offset) {
        this.sendGoawayAndClose(ErrorCode.PROTOCOL_ERROR);
        return;
      }
      payload = payload.subarray(offset, payload.length - padLength);
      offset = 0; // reset for PRIORITY processing on the trimmed payload
    }

    if (frame.flags & FrameFlags.PRIORITY) {
      // PRIORITY: 4-byte dependency + 1-byte weight = 5 bytes
      if (payload.length < 5) {
        this.sendGoawayAndClose(ErrorCode.PROTOCOL_ERROR);
        return;
      }
      payload = payload.subarray(5);
    }

    if (endHeaders) {
      this.processHeaderBlock(frame.streamId, payload, endStream);
    } else {
      // Start collecting CONTINUATION frames
      this.continuationStreamId = frame.streamId;
      this.continuationBuffer = [payload];
      this.continuationBufferSize = payload.length;
      this.continuationEndStream = endStream;
    }
  }

  private async processHeaderBlock(
    streamId: number,
    headerBlock: Buffer,
    endStream: boolean,
  ): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) return;

    // HEADERS on half-closed (remote) or closed stream is a stream error (RFC 7540 Section 5.1)
    if (stream.state === "half-closed-remote" || stream.state === "closed") {
      this.writeRaw(encodeRstStream(streamId, ErrorCode.STREAM_CLOSED)).catch(() => {});
      return;
    }

    try {
      const headers = await this.hpackDecoder.decode(headerBlock);
      stream.handleHeaders(headers, endStream);
    } catch {
      // HPACK decode failure is a connection-level error (RFC 7540 Section 4.3)
      // because the dynamic table state is now out of sync
      this.sendGoawayAndClose(ErrorCode.COMPRESSION_ERROR);
    }
  }

  private handleSettingsFrame(frame: Frame): void {
    // SETTINGS must be on stream 0 (RFC 7540 Section 6.5)
    if (frame.streamId !== 0) {
      this.sendGoawayAndClose(ErrorCode.PROTOCOL_ERROR);
      return;
    }

    if (frame.flags & FrameFlags.ACK) {
      // SETTINGS ACK must have empty payload (RFC 7540 Section 6.5)
      if (frame.payload.length !== 0) {
        this.sendGoawayAndClose(ErrorCode.FRAME_SIZE_ERROR);
        return;
      }
      if (this.settingsAckResolve) {
        this.settingsAckResolve();
        this.settingsAckResolve = null;
      }
      return;
    }

    // Parse settings
    const payload = frame.payload;
    if (payload.length % 6 !== 0) {
      this.sendGoawayAndClose(ErrorCode.FRAME_SIZE_ERROR);
      return;
    }
    for (let i = 0; i + 5 < payload.length; i += 6) {
      const id = payload.readUInt16BE(i) as SettingsId;
      const value = payload.readUInt32BE(i + 2);

      // Validate parameter values (RFC 7540 Section 6.5.2)
      if (id === SettingsId.INITIAL_WINDOW_SIZE && value > 0x7fffffff) {
        this.sendGoawayAndClose(ErrorCode.FLOW_CONTROL_ERROR);
        return;
      }
      if (id === SettingsId.MAX_FRAME_SIZE && (value < 16384 || value > 16777215)) {
        this.sendGoawayAndClose(ErrorCode.PROTOCOL_ERROR);
        return;
      }
      if (id === SettingsId.ENABLE_PUSH && value > 1) {
        this.sendGoawayAndClose(ErrorCode.PROTOCOL_ERROR);
        return;
      }

      this.remoteSettings.set(id, value);

      // Note: remote MAX_FRAME_SIZE affects send-side only.
      // Receive-side max is our local setting (parser initialized from OPTIMIZED_MAX_FRAME_SIZE).

      // Update stream initial window sizes if changed
      if (id === SettingsId.INITIAL_WINDOW_SIZE) {
        const oldSize = this.lastRemoteInitialWindowSize;
        for (const stream of this.streams.values()) {
          stream.sendWindow.reset(value, oldSize);
        }
        this.lastRemoteInitialWindowSize = value;
      }
    }

    // Send SETTINGS ACK
    this.writeRaw(encodeSettings([], true)).catch(() => {});

    if (this.remoteSettingsResolve) {
      this.remoteSettingsResolve();
      this.remoteSettingsResolve = null;
    }
  }

  private handleWindowUpdateFrame(frame: Frame): void {
    if (frame.payload.length !== 4) {
      this.sendGoawayAndClose(ErrorCode.FRAME_SIZE_ERROR);
      return;
    }
    const increment = frame.payload.readUInt32BE(0) & 0x7fffffff;
    if (increment === 0) {
      // PROTOCOL_ERROR for zero increment
      if (frame.streamId === 0) {
        this.writeRaw(encodeGoaway(0, ErrorCode.PROTOCOL_ERROR)).catch(() => {});
      } else {
        this.writeRaw(encodeRstStream(frame.streamId, ErrorCode.PROTOCOL_ERROR)).catch(() => {});
      }
      return;
    }

    try {
      if (frame.streamId === 0) {
        this.connectionSendWindow.update(increment);
      } else {
        const stream = this.streams.get(frame.streamId);
        if (stream) {
          stream.handleWindowUpdate(increment);
        }
      }
    } catch {
      // Flow control window overflow (RFC 7540 Section 6.9.1)
      if (frame.streamId === 0) {
        this.sendGoawayAndClose(ErrorCode.FLOW_CONTROL_ERROR);
      } else {
        this.writeRaw(encodeRstStream(frame.streamId, ErrorCode.FLOW_CONTROL_ERROR)).catch(
          () => {},
        );
      }
    }
  }

  private handlePingFrame(frame: Frame): void {
    if (frame.payload.length !== 8) {
      this.sendGoawayAndClose(ErrorCode.FRAME_SIZE_ERROR);
      return;
    }
    if (frame.flags & FrameFlags.ACK) return; // ignore PING ACK
    // Reply with PING ACK
    this.writeRaw(encodePing(frame.payload, true)).catch(() => {});
  }

  private handleGoawayFrame(frame: Frame): void {
    if (frame.payload.length < 8) {
      this.sendGoawayAndClose(ErrorCode.FRAME_SIZE_ERROR);
      return;
    }
    this.goawayReceived = true;
    const lastStreamId = frame.payload.readUInt32BE(0) & 0x7fffffff;
    const errorCode = frame.payload.readUInt32BE(4) as ErrorCode;

    // Close streams with ID > lastStreamId
    for (const [id, stream] of this.streams) {
      if (id > lastStreamId) {
        stream.handleRstStream(ErrorCode.REFUSED_STREAM);
        this.streams.delete(id);
      }
    }

    this.emit("goaway", { lastStreamId, errorCode });
  }

  private handleRstStreamFrame(frame: Frame): void {
    if (frame.payload.length !== 4) {
      this.sendGoawayAndClose(ErrorCode.FRAME_SIZE_ERROR);
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (stream) {
      const errorCode = frame.payload.readUInt32BE(0) as ErrorCode;
      stream.handleRstStream(errorCode);
    }
  }

  /** Send GOAWAY with given error code and close the connection. */
  private sendGoawayAndClose(errorCode: ErrorCode): void {
    if (this.closed) return;
    const lastStreamId = Math.max(0, this.nextStreamId - 2);
    this.writeRaw(encodeGoaway(lastStreamId, errorCode)).catch(() => {});
    this.closed = true;
    for (const stream of this.streams.values()) {
      stream.handleRstStream(ErrorCode.CANCEL);
    }
    this.streams.clear();
    this.connectionSendWindow.cancel();
    this.socket.end();
    this.emit("goaway", { lastStreamId, errorCode });
  }

  private handleError(err: Error): void {
    // Parser/protocol errors should terminate the connection with GOAWAY
    const errorCode = err.message?.includes("Frame size")
      ? ErrorCode.FRAME_SIZE_ERROR
      : ErrorCode.PROTOCOL_ERROR;
    this.sendGoawayAndClose(errorCode);
    this.emit("error", err);
  }

  private handleSocketClose(): void {
    if (!this.closed) {
      this.closed = true;
      for (const stream of this.streams.values()) {
        stream.handleRstStream(ErrorCode.CANCEL);
      }
      this.streams.clear();
      this.connectionSendWindow.cancel();
      this.emit("close");
    }
  }

  /**
   * Queue a frame for writing. Frames queued in the same microtask
   * are coalesced into a single socket.write() call.
   */
  private writeRaw(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingWrites.push(data);
      this.flushPromiseResolvers.push({ resolve, reject });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flush());
      }
    });
  }

  /** Flush all pending writes as a single socket.write(). */
  private flush(): void {
    this.flushScheduled = false;
    const writes = this.pendingWrites;
    const resolvers = this.flushPromiseResolvers;
    this.pendingWrites = [];
    this.flushPromiseResolvers = [];
    if (writes.length === 0) return;

    const merged = writes.length === 1 ? writes[0] : Buffer.concat(writes);
    this.socket.write(merged, (err?: Error | null) => {
      for (const r of resolvers) {
        if (err) r.reject(err);
        else r.resolve();
      }
    });
  }

  /** Write multiple frames as a single socket.write() immediately (no microtask delay). */
  private writeMulti(frames: Buffer[]): Promise<void> {
    if (frames.length === 0) return Promise.resolve();
    const merged = frames.length === 1 ? frames[0] : Buffer.concat(frames);
    return new Promise((resolve, reject) => {
      this.socket.write(merged, (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Whether the connection has been initialized and is usable */
  get isReady(): boolean {
    return this.initialized && !this.closed && !this.goawayReceived;
  }

  /** Number of currently active (open) streams */
  get activeStreamCount(): number {
    return this.streams.size;
  }

  /** Remote peer's MAX_CONCURRENT_STREAMS setting (default: 100) */
  get maxConcurrentStreams(): number {
    return this.remoteSettings.get(SettingsId.MAX_CONCURRENT_STREAMS) ?? 100;
  }
}
