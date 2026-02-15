/**
 * NAT64 address resolution for bypassing Cloudflare Workers
 * outbound socket restrictions.
 *
 * Converts IPv4 targets to NAT64 IPv6 addresses using public NAT64 gateways.
 * Prefixes verified via RFC 7050 (querying DNS64 servers for ipv4only.arpa).
 */

import { CF_IPV4_RANGES } from "./cloudflare-ranges.js";

/**
 * NAT64 /96 prefixes, ordered by reliability.
 * Format: full expanded prefix ending with ":" (no trailing "::").
 * The last 32 bits (2 hextets) are filled with the embedded IPv4 address.
 *
 * To convert: prefix + hex(octet1)hex(octet2):hex(octet3)hex(octet4)
 * Example: "2602:fc59:b0:64::" + 108.160.165.8 → [2602:fc59:b0:64::6ca0:a508]
 */
const NAT64_PREFIXES = [
  // === Verified working from CF Workers (deploy tested) ===
  "2602:fc59:b0:64::", // ZTVI/ForwardingPlane, Fremont CA, USA — 12ms
  "2602:fc59:11:64::", // ZTVI/ForwardingPlane, Chicago, USA — 60ms
  "2a00:1098:2b:0:0:1:", // Kasper Dupont (nat64.net), Amsterdam — 150ms
  "2a00:1098:2c:0:0:5:", // Kasper Dupont (nat64.net), London — 140ms
  "2a02:898:146:64::", // IPng Networks, Netherlands — 155ms
  "2001:67c:2b0:db32::", // Trex, Tampere, Finland — 195ms

  // === Additional ZTVI/ForwardingPlane prefixes ===
  "2602:fc59:20::", // ZTVI/ForwardingPlane, unknown location

  // === Kasper Dupont (nat64.net) additional locations ===
  "2a00:1098:2c:1::", // nat64.net, London (official /96 prefix)
  "2a01:4f8:c2c:123f:64:5:", // nat64.net, Nuremberg, Germany
  "2a01:4f8:c2c:123f:64::", // nat64.net, Nuremberg (alternate form)
  "2a01:4f9:c010:3f02:64:0:", // nat64.net, Helsinki, Finland
  "2a01:4f9:c010:3f02:64::", // nat64.net, Helsinki (alternate form)

  // === level66.network ===
  "2001:67c:2960:6464::", // level66.network, Germany (Anycast)
  "2a09:11c0:f1:be00::", // level66.network, Frankfurt

  // === go6Labs, Slovenia ===
  "2001:67c:27e4:642::", // go6Labs, Slovenia
  "2001:67c:27e4:64::", // go6Labs, Slovenia
  "2001:67c:27e4:1064::", // go6Labs, Slovenia
  "2001:67c:27e4:11::", // go6Labs, Slovenia

  // === Other providers ===
  "2a03:7900:6446::", // Tuxis, Netherlands
  "2001:67c:2b0:db32:0:1:", // Trex, second prefix, Finland
];

/** Exported for testing */
export { NAT64_PREFIXES };

export interface DnsARecord {
  ipv4: string;
  ttl: number;
}

interface DnsJsonResponse {
  Answer?: Array<{ type: number; data: string; TTL: number }>;
}

async function dohQuery(
  name: string,
  type: "A",
  signal?: AbortSignal,
): Promise<DnsJsonResponse | null> {
  try {
    const resp = await fetch(
      `https://1.1.1.1/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { Accept: "application/dns-json" }, signal: signal ?? AbortSignal.timeout(3000) },
    );
    if (!resp.ok) return null;

    return (await resp.json()) as DnsJsonResponse;
  } catch {
    return null;
  }
}

/**
 * Resolve hostname to IPv4 via DNS-over-HTTPS (Cloudflare 1.1.1.1).
 * Uses fetch() which is always available in CF Workers.
 */
export async function resolveIPv4(hostname: string): Promise<DnsARecord | null> {
  const data = await dohQuery(hostname, "A");
  if (!data || !data.Answer) return null;

  const aRecord = data.Answer.find(r => r.type === 1);
  if (!aRecord) return null;

  return { ipv4: aRecord.data, ttl: aRecord.TTL };
}

/**
 * Convert IPv4 string to NAT64 IPv6 address (bracketed for connect()).
 *
 * Handles two prefix formats:
 * - Ending with "::" (short prefix, e.g. "2602:fc59:b0:64::")
 *   → [2602:fc59:b0:64::6ca0:a508]
 * - Ending with ":" (full prefix, e.g. "2a00:1098:2b:0:0:1:")
 *   → [2a00:1098:2b:0:0:1:6ca0:a508]
 */
export function ipv4ToNAT64(ipv4: string, prefix: string): string {
  const parts = ipv4.split(".");
  if (parts.length !== 4) throw new Error(`Invalid IPv4: ${ipv4}`);

  const hex = parts.map(p => {
    const n = parseInt(p, 10);
    if (Number.isNaN(n) || n < 0 || n > 255) throw new Error(`Invalid IPv4 octet: ${p}`);
    return n.toString(16).padStart(2, "0");
  });

  const suffix = `${hex[0]}${hex[1]}:${hex[2]}${hex[3]}`;
  return `[${prefix}${suffix}]`;
}

export interface BypassResult {
  strategy: "nat64";
  /** The hostname to pass to connect() */
  connectHostname: string;
  /** NAT64 prefix used */
  nat64Prefix: string;
  /** Original IPv4 resolved from DNS */
  resolvedIPv4: string;
}

/**
 * Generate NAT64 bypass hostname candidates for a given domain.
 * Returns an array of { connectHostname, nat64Prefix } to try in order.
 */
export async function generateBypassCandidates(hostname: string): Promise<BypassResult[]> {
  const dns = await resolveIPv4(hostname);
  if (!dns) return [];

  return NAT64_PREFIXES.map(prefix => ({
    strategy: "nat64" as const,
    connectHostname: ipv4ToNAT64(dns.ipv4, prefix),
    nat64Prefix: prefix,
    resolvedIPv4: dns.ipv4,
  }));
}

/** Check if an error is a CF Workers network restriction error */
export function isCloudflareNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("cannot connect to the specified address") ||
    msg.includes("A network issue was detected") ||
    msg.includes("TCP Loop detected")
  );
}

// ── Cloudflare IP range detection ──────────────────────────────

function ipv4ToUint32(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function isCloudflareIPv4(ipv4: string): boolean {
  const num = ipv4ToUint32(ipv4);
  return CF_IPV4_RANGES.some(([start, end]) => num >= start && num <= end);
}

export interface CfCheckResult {
  isCf: boolean;
  ipv4: string | null;
  dnsMs: number;
  /** TTL from A record (seconds). 0 if no record found. */
  ttl: number;
}

/**
 * Resolve hostname via DoH (A record only), check if IP is in CF ranges.
 * Used to pre-detect CF CDN targets that need NAT64 bypass.
 *
 * Only queries A records — the IPv4 is needed for NAT64 conversion and
 * isCloudflareIPv4() is sufficient for CF detection. Skipping AAAA saves
 * one fetch subrequest per hostname from the shared 6-connection budget.
 */
export async function resolveAndCheckCloudflare(hostname: string): Promise<CfCheckResult> {
  const t0 = Date.now();
  const aData = await dohQuery(hostname, "A", AbortSignal.timeout(3000));
  const dnsMs = Date.now() - t0;

  let ipv4: string | null = null;
  let isCf = false;
  let ttl = 0;

  if (aData) {
    const aRecord = aData.Answer?.find(r => r.type === 1);
    if (aRecord) {
      ipv4 = aRecord.data;
      ttl = aRecord.TTL;
      if (isCloudflareIPv4(ipv4)) isCf = true;
    }
  }

  return { isCf, ipv4, dnsMs, ttl };
}
