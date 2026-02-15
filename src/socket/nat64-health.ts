/**
 * Lightweight in-isolate NAT64 prefix health tracking.
 * Used to rank prefixes by recent success and latency.
 */

interface PrefixHealth {
  ok: number;
  fail: number;
  ewmaRttMs: number;
}

const DEFAULT_RTT_MS = 700;
const EWMA_ALPHA = 0.3;
const FAILURE_PENALTY_MS = 250;

const health = new Map<string, PrefixHealth>();

function getOrInit(prefix: string): PrefixHealth {
  const existing = health.get(prefix);
  if (existing) return existing;
  const init: PrefixHealth = { ok: 0, fail: 0, ewmaRttMs: DEFAULT_RTT_MS };
  health.set(prefix, init);
  return init;
}

function score(prefix: string): number {
  const stat = health.get(prefix);
  if (!stat) return DEFAULT_RTT_MS;

  const total = stat.ok + stat.fail;
  const failRatio = total > 0 ? stat.fail / total : 0;
  return stat.ewmaRttMs + failRatio * FAILURE_PENALTY_MS;
}

/**
 * Rank candidate prefixes (lower score first) based on in-memory health stats.
 */
export function rankNat64Prefixes(prefixes: readonly string[]): string[] {
  return [...prefixes].sort((a, b) => score(a) - score(b));
}

/**
 * Record result for a NAT64 prefix attempt.
 */
export function recordNat64PrefixResult(prefix: string, ok: boolean, rttMs: number): void {
  const stat = getOrInit(prefix);
  if (ok) stat.ok += 1;
  else stat.fail += 1;

  const bounded = Math.max(1, Math.min(rttMs, 60_000));
  stat.ewmaRttMs = stat.ewmaRttMs * (1 - EWMA_ALPHA) + bounded * EWMA_ALPHA;
}

/**
 * Clear all prefix health stats.
 * Useful for tests and advanced users.
 */
export function clearNat64PrefixStats(): void {
  health.clear();
}
