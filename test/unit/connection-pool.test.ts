import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPooledClient, poolClient, removePooled, clearPool } from "../../src/connection-pool.js";

/** Create a mock Http2Client with configurable capacity */
function createMockClient(opts: { isReady?: boolean; hasCapacity?: boolean } = {}) {
  return {
    isReady: opts.isReady ?? true,
    hasCapacity: opts.hasCapacity ?? true,
    activeStreamCount: 0,
    maxConcurrentStreams: 100,
    close: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    onGoaway: vi.fn(),
    offGoaway: vi.fn(),
  } as any;
}

describe("Connection Pool", () => {
  beforeEach(() => {
    clearPool();
  });

  describe("getPooledClient", () => {
    it("should return null for unknown origin", () => {
      expect(getPooledClient("example.com", 443)).toBeNull();
    });

    it("should return pooled client for known origin", () => {
      const client = createMockClient();
      poolClient("example.com", 443, client);

      const result = getPooledClient("example.com", 443);
      expect(result).toBe(client);
    });

    it("should distinguish different ports", () => {
      const client443 = createMockClient();
      const client8443 = createMockClient();
      poolClient("example.com", 443, client443);
      poolClient("example.com", 8443, client8443);

      expect(getPooledClient("example.com", 443)).toBe(client443);
      expect(getPooledClient("example.com", 8443)).toBe(client8443);
    });

    it("should distinguish different hostnames", () => {
      const clientA = createMockClient();
      const clientB = createMockClient();
      poolClient("a.com", 443, clientA);
      poolClient("b.com", 443, clientB);

      expect(getPooledClient("a.com", 443)).toBe(clientA);
      expect(getPooledClient("b.com", 443)).toBe(clientB);
    });

    it("should return null and close client when hasCapacity is false", () => {
      const client = createMockClient({ hasCapacity: false });
      poolClient("example.com", 443, client);

      const result = getPooledClient("example.com", 443);
      expect(result).toBeNull();
      expect(client.close).toHaveBeenCalled();
    });

    it("should return null and close client after TTL expires", () => {
      vi.useFakeTimers();
      try {
        const client = createMockClient();
        poolClient("example.com", 443, client);

        // Advance past 60s TTL
        vi.advanceTimersByTime(61_000);

        const result = getPooledClient("example.com", 443);
        expect(result).toBeNull();
        expect(client.close).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("should return client before TTL expires", () => {
      vi.useFakeTimers();
      try {
        const client = createMockClient();
        poolClient("example.com", 443, client);

        // Advance to just before TTL
        vi.advanceTimersByTime(59_000);

        const result = getPooledClient("example.com", 443);
        expect(result).toBe(client);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should update lastUsedAt on access", () => {
      vi.useFakeTimers();
      try {
        const client = createMockClient();
        poolClient("example.com", 443, client);

        // Advance 50s then access (refreshes lastUsedAt)
        vi.advanceTimersByTime(50_000);
        const result = getPooledClient("example.com", 443);
        expect(result).toBe(client);

        // Advance another 50s (total 100s from pool, but 50s from last access)
        vi.advanceTimersByTime(50_000);
        const result2 = getPooledClient("example.com", 443);
        expect(result2).toBe(client); // still alive because last access was 50s ago
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("poolClient", () => {
    it("should overwrite existing entry for same origin", () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      poolClient("example.com", 443, client1);
      poolClient("example.com", 443, client2);

      expect(getPooledClient("example.com", 443)).toBe(client2);
    });

    it("should evict oldest entry when pool is full", () => {
      // Fill pool to MAX_POOL_SIZE (20)
      const clients: any[] = [];
      for (let i = 0; i < 20; i++) {
        const client = createMockClient();
        poolClient(`host${i}.com`, 443, client);
        clients.push(client);
      }

      // Add one more — should evict the oldest (host0.com)
      const newClient = createMockClient();
      poolClient("new-host.com", 443, newClient);

      expect(getPooledClient("host0.com", 443)).toBeNull();
      expect(clients[0].close).toHaveBeenCalled();
      expect(getPooledClient("new-host.com", 443)).toBe(newClient);
      // host1.com should still exist
      expect(getPooledClient("host1.com", 443)).toBe(clients[1]);
    });
  });

  describe("GOAWAY listener dedup", () => {
    it("should not register duplicate GOAWAY listeners on re-pool", () => {
      const client = createMockClient();
      // Pool the same client multiple times (simulating checkout → return → checkout → return)
      poolClient("goaway-test.com", 443, client);
      poolClient("goaway-test.com", 443, client);
      poolClient("goaway-test.com", 443, client);

      // onGoaway should only be called once despite 3 poolClient calls
      expect(client.onGoaway).toHaveBeenCalledTimes(1);
    });

    it("should register separate listeners for different clients", () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      poolClient("a.com", 443, client1);
      poolClient("b.com", 443, client2);

      expect(client1.onGoaway).toHaveBeenCalledTimes(1);
      expect(client2.onGoaway).toHaveBeenCalledTimes(1);
    });
  });

  describe("removePooled", () => {
    it("should remove and close pooled client", () => {
      const client = createMockClient();
      poolClient("example.com", 443, client);

      removePooled("example.com", 443);

      expect(getPooledClient("example.com", 443)).toBeNull();
      expect(client.close).toHaveBeenCalled();
    });

    it("should be a no-op for unknown origin", () => {
      // Should not throw
      removePooled("unknown.com", 443);
    });
  });

  describe("clearPool", () => {
    it("should close all pooled clients", () => {
      const client1 = createMockClient();
      const client2 = createMockClient();
      poolClient("a.com", 443, client1);
      poolClient("b.com", 443, client2);

      clearPool();

      expect(client1.close).toHaveBeenCalled();
      expect(client2.close).toHaveBeenCalled();
      expect(getPooledClient("a.com", 443)).toBeNull();
      expect(getPooledClient("b.com", 443)).toBeNull();
    });
  });
});
