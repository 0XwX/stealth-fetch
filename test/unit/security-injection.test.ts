
import { describe, it, expect } from "vitest";
import { http1Request } from "../../src/http1/client.js";
import { Duplex } from "node:stream";

class MockSocket extends Duplex {
  public writtenData: string[] = [];
  _write(chunk: any, encoding: any, callback: any) {
    this.writtenData.push(chunk.toString());
    callback();
  }
  _read() {
    this.push(null); // End of stream
  }
}

describe("HTTP/1.1 Request Method Injection", () => {
  it("should prevent CRLF injection in method", async () => {
    const socket = new MockSocket();
    const maliciousMethod = "GET / HTTP/1.1\r\nX-Evil: True\r\n\r\nPOST";

    // Attempt request with malicious method
    await expect(http1Request(socket, {
      method: maliciousMethod,
      path: "/target",
      hostname: "example.com",
      headers: {},
    })).rejects.toThrow(/Invalid method/);

    const fullRequest = socket.writtenData.join("");

    // Ensure nothing was written (or at least no injection)
    expect(fullRequest).toBe("");
  });

  it("should prevent path injection", async () => {
    const socket = new MockSocket();
    const maliciousPath = "/ HTTP/1.1\r\nX-Injected: Header";

    // Attempt request with malicious path
    await expect(http1Request(socket, {
      method: "GET",
      path: maliciousPath,
      hostname: "example.com",
      headers: {},
    })).rejects.toThrow(/Invalid path/);

    const fullRequest = socket.writtenData.join("");
    expect(fullRequest).toBe("");
  });
});
