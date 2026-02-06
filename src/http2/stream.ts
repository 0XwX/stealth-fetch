/**
 * HTTP/2 stream: represents a single request/response exchange.
 * Stream IDs are odd for client-initiated streams (1, 3, 5, ...).
 */
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { ErrorCode } from "./constants.js";
import { FlowControlWindow } from "./flow-control.js";

/** Stream states (RFC 7540 Section 5.1) */
export type StreamState = "idle" | "open" | "half-closed-local" | "half-closed-remote" | "closed";

export interface Http2ResponseData {
  status: number;
  headers: Record<string, string>;
  rawHeaders: Array<[string, string]>;
}

/**
 * Single HTTP/2 stream.
 * Managed by Http2Connection, which calls handle* methods when frames arrive.
 */
export class Http2Stream extends EventEmitter {
  readonly id: number;
  private _state: StreamState = "idle";
  readonly sendWindow: FlowControlWindow;

  // Receive window tracking for WINDOW_UPDATE thresholding
  recvWindowConsumed = 0;
  readonly recvWindowSize: number;

  // Response data
  private responseHeaders: Array<[string, string]> | null = null;
  private responseEndStream = false;
  private responsePromiseResolve: ((value: Http2ResponseData) => void) | null = null;
  private responsePromiseReject: ((err: Error) => void) | null = null;
  private responsePromiseSettled = false;

  // Body streaming
  private bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private bodyStreamClosed = false;
  readonly body: ReadableStream<Uint8Array>;

  // Body timeout (idle)
  private bodyTimeoutMs: number | null = null;
  private bodyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Callback to notify connection when body is cancelled (for RST_STREAM) */
  private onBodyCancel: ((streamId: number) => void) | null = null;
  /** Callback to request RST_STREAM without altering local state */
  private onSendRst: ((streamId: number, errorCode: ErrorCode) => void) | null = null;

  constructor(id: number, initialSendWindowSize: number, recvWindowSize: number = 65535) {
    super();
    this.id = id;
    this.sendWindow = new FlowControlWindow(initialSendWindowSize);
    this.recvWindowSize = recvWindowSize;

    this.body = new ReadableStream<Uint8Array>({
      start: controller => {
        this.bodyController = controller;
      },
      cancel: () => {
        this.bodyStreamClosed = true;
        // Notify connection to send RST_STREAM(CANCEL) so server stops sending
        if (this._state !== "closed" && this.onBodyCancel) {
          this.onBodyCancel(this.id);
        }
      },
    });
  }

  get state(): StreamState {
    return this._state;
  }

  /** Transition to open state (after sending HEADERS) */
  open(): void {
    this._state = "open";
  }

  /** Transition to half-closed-local (after sending END_STREAM) */
  halfCloseLocal(): void {
    if (this._state === "open") {
      this._state = "half-closed-local";
    } else if (this._state === "half-closed-remote") {
      this.close();
    }
  }

  /** Handle received response HEADERS */
  handleHeaders(headers: Array<[string, string]>, endStream: boolean): void {
    this.responseHeaders = headers;
    this.responseEndStream = endStream;

    // Extract status and build headers object
    const headerObj: Record<string, string> = {};
    const rawHeaders: Array<[string, string]> = [];
    let status = 200;
    for (const [name, value] of headers) {
      if (name === ":status") {
        const s = parseInt(value, 10);
        // RFC 7540 Section 8.1.2.4: status must be a 3-digit integer
        if (isNaN(s) || s < 100 || s > 599) {
          const err = new Error(`Invalid HTTP/2 :status pseudo-header: ${value}`);
          if (this.responsePromiseReject) {
            this.responsePromiseReject(err);
            this.responsePromiseResolve = null;
            this.responsePromiseReject = null;
          }
          this.closeBodyWithError(err);
          return;
        }
        status = s;
      } else if (!name.startsWith(":")) {
        rawHeaders.push([name, value]);
        headerObj[name] = headerObj[name] ? `${headerObj[name]}, ${value}` : value;
      }
    }

    if (this.responsePromiseResolve) {
      this.responsePromiseResolve({ status, headers: headerObj, rawHeaders });
      this.responsePromiseResolve = null;
      this.responsePromiseReject = null;
    }

    if (!endStream) {
      this.resetBodyTimer();
    } else {
      this.clearBodyTimer();
    }

    if (endStream) {
      this.handleRemoteEndStream();
    }
  }

  /** Handle received DATA frame */
  handleData(data: Buffer, endStream: boolean): void {
    if (this.bodyController && !this.bodyStreamClosed) {
      try {
        // data is already a copied buffer from the parser; safe to enqueue directly
        this.bodyController.enqueue(data);
      } catch {
        // stream closed
      }
    }

    if (!endStream) {
      this.resetBodyTimer();
    }

    if (endStream) {
      this.handleRemoteEndStream();
    }
  }

  /** Handle RST_STREAM from peer */
  handleRstStream(errorCode: ErrorCode): void {
    const err = new Error(`Stream reset by peer: error code ${errorCode}`);
    if (this.responsePromiseReject) {
      this.responsePromiseReject(err);
      this.responsePromiseResolve = null;
      this.responsePromiseReject = null;
    }
    this.clearBodyTimer();
    this.closeBodyWithError(err);
    this.close();
  }

  /** Handle WINDOW_UPDATE for this stream */
  handleWindowUpdate(increment: number): void {
    this.sendWindow.update(increment);
  }

  /** Register callback for body cancellation (connection uses this to send RST_STREAM) */
  setOnBodyCancel(callback: (streamId: number) => void): void {
    this.onBodyCancel = callback;
  }

  /** Register callback for sending RST_STREAM */
  setOnSendRst(callback: (streamId: number, errorCode: ErrorCode) => void): void {
    this.onSendRst = callback;
  }

  private handleRemoteEndStream(): void {
    if (this._state === "open") {
      this._state = "half-closed-remote";
    } else if (this._state === "half-closed-local") {
      this.close();
    }
    this.clearBodyTimer();
    this.closeBody();
  }

  private close(): void {
    this._state = "closed";
    this.sendWindow.cancel();
    this.clearBodyTimer();
    this.closeBody();
    this.emit("close");
  }

  private closeBody(): void {
    if (this.bodyController && !this.bodyStreamClosed) {
      this.bodyStreamClosed = true;
      try {
        this.bodyController.close();
      } catch {
        // ignore
      }
    }
  }

  private closeBodyWithError(err: Error): void {
    if (this.bodyController && !this.bodyStreamClosed) {
      this.bodyStreamClosed = true;
      try {
        this.bodyController.error(err);
      } catch {
        // ignore
      }
    }
  }

  /** Set idle timeout for response body (ms) */
  setBodyTimeout(timeout?: number): void {
    if (typeof timeout !== "number" || timeout <= 0 || timeout === Infinity) {
      this.bodyTimeoutMs = null;
      this.clearBodyTimer();
      return;
    }
    this.bodyTimeoutMs = timeout;
    if (this.responseHeaders && !this.responseEndStream) {
      this.resetBodyTimer();
    }
  }

  /** Wait for response headers with optional timeout (ms) */
  waitForResponse(headersTimeout?: number): Promise<Http2ResponseData> {
    if (this.responseHeaders) {
      // Already received
      const headerObj: Record<string, string> = {};
      const rawHeaders: Array<[string, string]> = [];
      let status = 200;
      for (const [name, value] of this.responseHeaders) {
        if (name === ":status") {
          const s = parseInt(value, 10);
          if (!isNaN(s) && s >= 100 && s <= 599) {
            status = s;
          }
        } else if (!name.startsWith(":")) {
          rawHeaders.push([name, value]);
          headerObj[name] = headerObj[name] ? `${headerObj[name]}, ${value}` : value;
        }
      }
      return Promise.resolve({ status, headers: headerObj, rawHeaders });
    }

    return new Promise<Http2ResponseData>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (typeof headersTimeout === "number" && headersTimeout > 0 && headersTimeout < Infinity) {
        timer = setTimeout(() => {
          if (this.responsePromiseSettled) return;
          this.responsePromiseSettled = true;
          const err = new DOMException(`Headers timeout after ${headersTimeout}ms`, "TimeoutError");
          this.responsePromiseResolve = null;
          this.responsePromiseReject = null;
          this.onSendRst?.(this.id, ErrorCode.CANCEL);
          this.closeBodyWithError(err);
          this.close();
          reject(err);
        }, headersTimeout);
      }
      this.responsePromiseResolve = data => {
        if (this.responsePromiseSettled) return;
        this.responsePromiseSettled = true;
        if (timer) clearTimeout(timer);
        resolve(data);
      };
      this.responsePromiseReject = err => {
        if (this.responsePromiseSettled) return;
        this.responsePromiseSettled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      };
    });
  }

  private resetBodyTimer(): void {
    if (!this.bodyTimeoutMs || this.responseEndStream) return;
    this.clearBodyTimer();
    this.bodyTimer = setTimeout(() => {
      const err = new DOMException(`Body timeout after ${this.bodyTimeoutMs}ms`, "TimeoutError");
      this.onSendRst?.(this.id, ErrorCode.CANCEL);
      this.closeBodyWithError(err);
      this.close();
    }, this.bodyTimeoutMs);
  }

  private clearBodyTimer(): void {
    if (this.bodyTimer) {
      clearTimeout(this.bodyTimer);
      this.bodyTimer = null;
    }
  }
}
