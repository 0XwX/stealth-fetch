import { describe, it, expect } from "vitest";
import { FlowControlWindow } from "../../../src/http2/flow-control.js";

describe("FlowControlWindow", () => {
  it("should initialize with given size", () => {
    const w = new FlowControlWindow(65535);
    expect(w.size).toBe(65535);
  });

  it("should initialize with default size when no arg", () => {
    const w = new FlowControlWindow();
    expect(w.size).toBe(65535);
  });

  it("should consume immediately when window is sufficient", async () => {
    const w = new FlowControlWindow(1000);
    await w.consume(300);
    expect(w.size).toBe(700);
  });

  it("should consume multiple times", async () => {
    const w = new FlowControlWindow(1000);
    await w.consume(300);
    await w.consume(200);
    expect(w.size).toBe(500);
  });

  it("should handle zero-size consume as no-op", async () => {
    const w = new FlowControlWindow(1000);
    await w.consume(0);
    expect(w.size).toBe(1000);
  });

  it("should handle negative-size consume as no-op", async () => {
    const w = new FlowControlWindow(1000);
    await w.consume(-1);
    expect(w.size).toBe(1000);
  });

  it("should block when window is exhausted and resolve on update", async () => {
    const w = new FlowControlWindow(100);

    // Exhaust the window
    await w.consume(100);
    expect(w.size).toBe(0);

    // This should block
    let resolved = false;
    const promise = w.consume(50).then(() => {
      resolved = true;
    });

    // Not yet resolved
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    // Update window
    w.update(50);
    await promise;
    expect(resolved).toBe(true);
    expect(w.size).toBe(0);
  });

  it("should drain multiple waiters in FIFO order", async () => {
    const w = new FlowControlWindow(0);
    const order: number[] = [];

    const p1 = w.consume(10).then(() => order.push(1));
    const p2 = w.consume(20).then(() => order.push(2));

    // Update with enough for both
    w.update(30);
    await Promise.all([p1, p2]);

    expect(order).toEqual([1, 2]);
    expect(w.size).toBe(0);
  });

  it("should only drain waiters that fit in available window", async () => {
    const w = new FlowControlWindow(0);
    let resolved1 = false;
    let resolved2 = false;

    const p1 = w.consume(10).then(() => {
      resolved1 = true;
    });
    w.consume(50).then(() => {
      resolved2 = true;
    });

    // Only enough for first waiter
    w.update(10);
    await p1;

    expect(resolved1).toBe(true);
    expect(resolved2).toBe(false);
    expect(w.size).toBe(0);
  });

  it("should update window size correctly", () => {
    const w = new FlowControlWindow(100);
    w.update(50);
    expect(w.size).toBe(150);
  });

  it("should throw on window overflow (> 0x7fffffff)", () => {
    const w = new FlowControlWindow(0x7fffffff);
    expect(() => w.update(1)).toThrow("overflow");
  });

  it("should not throw at exactly 0x7fffffff", () => {
    const w = new FlowControlWindow(0x7ffffffe);
    expect(() => w.update(1)).not.toThrow();
    expect(w.size).toBe(0x7fffffff);
  });

  it("should reset window on SETTINGS change (positive delta)", async () => {
    const w = new FlowControlWindow(0);

    let resolved = false;
    const p = w.consume(10).then(() => {
      resolved = true;
    });

    // Reset from 0 to 100 (positive delta wakes waiters)
    w.reset(100, 0);
    await p;

    expect(resolved).toBe(true);
    // available was 0, delta = 100, consume(10) takes 10 => 90
    expect(w.size).toBe(90);
  });

  it("should reset window on SETTINGS change (negative delta)", () => {
    const w = new FlowControlWindow(100);
    w.reset(50, 100); // shrink by 50
    expect(w.size).toBe(50);
  });

  it("should cancel all pending waiters with rejection", async () => {
    const w = new FlowControlWindow(0);

    const p1 = w.consume(10);
    const p2 = w.consume(20);

    w.cancel();

    await expect(p1).rejects.toThrow("Flow control window cancelled");
    await expect(p2).rejects.toThrow("Flow control window cancelled");
  });

  it("should reject consume after cancel", async () => {
    const w = new FlowControlWindow(1000);
    w.cancel();
    await expect(w.consume(10)).rejects.toThrow("Flow control window cancelled");
  });

  it("should consume full window in one call", async () => {
    const w = new FlowControlWindow(65535);
    await w.consume(65535);
    expect(w.size).toBe(0);
  });
});
