/**
 * V8 isolate-level protocol cache.
 * Remembers whether a host supports H2 or only HTTP/1.1,
 * so subsequent requests can skip WASM TLS ALPN negotiation.
 *
 * Cache lives in the global scope of the V8 isolate.
 * CF Workers may reuse isolates across requests, so cached
 * entries persist for the isolate's lifetime. If the isolate
 * is recycled, the cache starts fresh — acceptable trade-off.
 */

interface CacheEntry {
  protocol: "h2" | "http/1.1";
  ts: number;
}

const TTL = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 200;

const cache = new Map<string, CacheEntry>();

function makeKey(hostname: string, port: number): string {
  return `${hostname}:${port}`;
}

export function getCachedProtocol(hostname: string, port: number): "h2" | "http/1.1" | null {
  const key = makeKey(hostname, port);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL) {
    cache.delete(key);
    return null;
  }
  // LRU: move to end (most recently used)
  cache.delete(key);
  cache.set(key, entry);
  return entry.protocol;
}

export function setCachedProtocol(
  hostname: string,
  port: number,
  protocol: "h2" | "http/1.1",
): void {
  // Evict oldest entries if at capacity
  if (cache.size >= MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(makeKey(hostname, port), { protocol, ts: Date.now() });
}
