/**
 * V8 isolate-level HTTP/2 connection pool.
 * Reuses H2 connections to the same origin, leveraging HTTP/2 stream
 * multiplexing to avoid redundant TCP + TLS + SETTINGS handshakes.
 *
 * Pool lives in the global scope of the V8 isolate.
 * CF Workers may reuse isolates across requests, so pooled connections
 * persist for the isolate's lifetime (subject to idle timeout).
 */
import type { Http2Client } from "./http2/client.js";

interface PoolEntry {
  client: Http2Client;
  lastUsedAt: number;
}

const POOL_TTL = 60_000; // 60s idle timeout
const MAX_POOL_SIZE = 20;

const pool = new Map<string, PoolEntry>();
const goawayRegistered = new WeakSet<Http2Client>();

function makeKey(hostname: string, port: number, connectHostname?: string): string {
  return connectHostname ? `${hostname}:${port}@${connectHostname}` : `${hostname}:${port}`;
}

/**
 * Get a pooled H2 client for the given origin.
 * Returns null if no usable connection exists.
 */
export function getPooledClient(
  hostname: string,
  port: number,
  connectHostname?: string,
): Http2Client | null {
  const key = makeKey(hostname, port, connectHostname);
  const entry = pool.get(key);
  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.lastUsedAt > POOL_TTL) {
    pool.delete(key);
    entry.client.close().catch(() => {});
    return null;
  }

  // Check if connection is still usable and has capacity
  if (!entry.client.hasCapacity) {
    pool.delete(key);
    entry.client.close().catch(() => {});
    return null;
  }

  entry.lastUsedAt = Date.now();
  return entry.client;
}

/**
 * Add an H2 client to the pool for reuse.
 */
export function poolClient(
  hostname: string,
  port: number,
  client: Http2Client,
  connectHostname?: string,
): void {
  const key = makeKey(hostname, port, connectHostname);

  // Evict oldest entry if at capacity
  if (pool.size >= MAX_POOL_SIZE && !pool.has(key)) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of pool) {
      if (v.lastUsedAt < oldestTime) {
        oldestTime = v.lastUsedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      const evicted = pool.get(oldestKey);
      pool.delete(oldestKey);
      evicted?.client.close().catch(() => {});
    }
  }

  // Close existing connection for same key before replacing
  const existing = pool.get(key);
  if (existing && existing.client !== client) {
    existing.client.close().catch(() => {});
  }

  // Auto-remove from pool on GOAWAY (register only once per client)
  if (!goawayRegistered.has(client)) {
    goawayRegistered.add(client);
    client.onGoaway(() => {
      const entry = pool.get(key);
      if (entry?.client === client) {
        pool.delete(key);
        client.close().catch(() => {});
      }
    });
  }

  pool.set(key, { client, lastUsedAt: Date.now() });
}

/**
 * Remove a client from the pool (e.g. on GOAWAY or error).
 */
export function removePooled(hostname: string, port: number, connectHostname?: string): void {
  const key = makeKey(hostname, port, connectHostname);
  const entry = pool.get(key);
  if (entry) {
    pool.delete(key);
    entry.client.close().catch(() => {});
  }
}

/**
 * Clear all pooled connections. Useful for testing.
 */
export function clearPool(): void {
  for (const entry of pool.values()) {
    entry.client.close().catch(() => {});
  }
  pool.clear();
}
