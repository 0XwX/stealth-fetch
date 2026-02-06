/**
 * HTTP/2 flow control window management.
 * Tracks available send window and blocks when exhausted.
 */
import { DEFAULT_INITIAL_WINDOW_SIZE } from "./constants.js";

/**
 * Flow control window for connection or stream level.
 * Tracks available bytes for sending DATA frames.
 */
export class FlowControlWindow {
  private available: number;
  private waiters: Array<{
    size: number;
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private cancelled = false;

  constructor(initialSize: number = DEFAULT_INITIAL_WINDOW_SIZE) {
    this.available = initialSize;
  }

  /** Get current available window size */
  get size(): number {
    return this.available;
  }

  /**
   * Consume window capacity before sending data.
   * Resolves immediately if window is sufficient, otherwise waits.
   * Throws if the window has been cancelled.
   */
  async consume(size: number): Promise<void> {
    if (size <= 0) return;
    if (this.cancelled) {
      throw new Error("Flow control window cancelled");
    }

    if (this.available >= size) {
      this.available -= size;
      return;
    }

    // Wait for window update
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ size, resolve, reject });
    });
  }

  /**
   * Update window capacity (on receiving WINDOW_UPDATE).
   * Wakes up any pending consumers.
   */
  update(increment: number): void {
    this.available += increment;

    // Check overflow (RFC 7540 Section 6.9.1)
    if (this.available > 0x7fffffff) {
      throw new Error("Flow control window overflow");
    }

    // Wake up waiters that can now proceed
    this.drainWaiters();
  }

  /**
   * Reset window to a new initial size (on SETTINGS change).
   */
  reset(newInitialSize: number, oldInitialSize: number): void {
    const delta = newInitialSize - oldInitialSize;
    this.available += delta;
    if (delta > 0) {
      this.drainWaiters();
    }
  }

  /** Cancel all pending waiters (on stream/connection close) */
  cancel(): void {
    this.cancelled = true;
    const err = new Error("Flow control window cancelled");
    for (const waiter of this.waiters) {
      waiter.reject(err);
    }
    this.waiters = [];
  }

  private drainWaiters(): void {
    while (this.waiters.length > 0 && this.available > 0) {
      const waiter = this.waiters[0];
      if (this.available >= waiter.size) {
        this.available -= waiter.size;
        this.waiters.shift();
        waiter.resolve();
      } else {
        break;
      }
    }
  }
}
