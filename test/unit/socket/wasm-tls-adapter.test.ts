import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let plaintextCallback: ((data: Uint8Array) => void) | null = null;
  const rawSocket = {
    connect: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
  };
  const session = {
    negotiatedAlpn: "http/1.1",
    write: vi.fn().mockResolvedValue(undefined),
    onPlaintext: vi.fn((callback: (data: Uint8Array) => void) => {
      plaintextCallback = callback;
    }),
    onClose: vi.fn(),
    onError: vi.fn(),
    close: vi.fn(),
  };
  return {
    rawSocket,
    session,
    resetPlaintextCallback: () => {
      plaintextCallback = null;
    },
    getPlaintextCallback: () => plaintextCallback,
  };
});

vi.mock("../../../src/socket/adapter.js", () => ({
  CloudflareSocketAdapter: class {
    constructor() {
      return mocks.rawSocket;
    }
  },
}));

vi.mock("../../../src/socket/wasm-tls-bridge.js", () => ({
  performTlsHandshake: vi.fn().mockResolvedValue(mocks.session),
}));

const { WasmTlsSocketAdapter } = await import("../../../src/socket/wasm-tls-adapter.js");

describe("WasmTlsSocketAdapter", () => {
  beforeEach(() => {
    mocks.rawSocket.connect.mockClear();
    mocks.rawSocket.pause.mockClear();
    mocks.rawSocket.resume.mockClear();
    mocks.rawSocket.destroy.mockClear();
    mocks.session.write.mockClear();
    mocks.session.onPlaintext.mockClear();
    mocks.session.onClose.mockClear();
    mocks.session.onError.mockClear();
    mocks.session.close.mockClear();
    mocks.resetPlaintextCallback();
  });

  it("should pause and resume the raw socket when plaintext backpressure is applied", async () => {
    const socket = new WasmTlsSocketAdapter({ hostname: "example.com", port: 443 });
    await socket.connect();

    mocks.getPlaintextCallback()!(new Uint8Array(64 * 1024));

    expect(mocks.rawSocket.pause).toHaveBeenCalled();

    socket._read();

    expect(mocks.rawSocket.resume).toHaveBeenCalled();
    socket.destroy();
  });
});
