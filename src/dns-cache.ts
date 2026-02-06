/**
 * V8 isolate-level DNS cache for CF CDN detection results.
 * Caches resolveAndCheckCloudflare() results (IPv4/IPv6 + isCf flag)
 * to avoid repeated DoH queries for the same hostname.
 *
 * Uses the same LRU pattern as protocol-cache.ts (Map delete+re-insert).
 * TTL is derived from DNS response TTL values (clamped to 30s–5min).
 */

import type { CfCheckResult } from "./socket/nat64.js";

interface DnsCacheEntry {
  ipv4: string | null;
  ipv6: string | null;
  isCf: boolean;
  expiresAt: number;
  dnsMs: number;
}

const MIN_TTL = 30_000; // 30s — floor to prevent TTL=0 hammering
const MAX_TTL = 5 * 60_000; // 5min — ceiling to prevent stale data
const MAX_ENTRIES = 500;

const cache = new Map<string, DnsCacheEntry>();

/**
 * Look up cached DNS result. Returns null on miss or expiry.
 * On hit, refreshes LRU position (Map delete+re-insert).
 */
export function getCachedDns(hostname: string): CfCheckResult | null {
  const entry = cache.get(hostname);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cache.delete(hostname);
    return null;
  }

  // LRU: move to end (most recently used)
  cache.delete(hostname);
  cache.set(hostname, entry);

  return {
    isCf: entry.isCf,
    ipv4: entry.ipv4,
    ipv6: entry.ipv6,
    dnsMs: 0, // cached — no actual DNS query
    ttl: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000)),
  };
}

/**
 * Store DNS result in cache with clamped TTL.
 * Evicts oldest entry if at capacity.
 */
export function setCachedDns(hostname: string, result: CfCheckResult): void {
  // ttl=0 is treated as a DoH failure degradation signal in this codebase.
  // Note: RFC allows TTL=0, but we intentionally use a short 10s negative cache here.
  const ttlMs = result.ttl > 0 ? Math.max(MIN_TTL, Math.min(result.ttl * 1000, MAX_TTL)) : 10_000;

  // Evict oldest entry if at capacity
  if (cache.size >= MAX_ENTRIES && !cache.has(hostname)) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }

  cache.set(hostname, {
    ipv4: result.ipv4,
    ipv6: result.ipv6,
    isCf: result.isCf,
    expiresAt: Date.now() + ttlMs,
    dnsMs: result.dnsMs,
  });
}

/** Clear all cached DNS entries. Exported for testing and user API. */
export function clearDnsCache(): void {
  cache.clear();
}
