/**
 * NAT64 address resolution for bypassing Cloudflare Workers
 * outbound socket restrictions.
 *
 * Converts IPv4 targets to NAT64 IPv6 addresses using public NAT64 gateways.
 * Prefixes verified via RFC 7050 (querying DNS64 servers for ipv4only.arpa).
 */

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

/**
 * Resolve hostname to IPv4 via DNS-over-HTTPS (Cloudflare 1.1.1.1).
 * Uses fetch() which is always available in CF Workers.
 */
export async function resolveIPv4(hostname: string): Promise<DnsARecord | null> {
  const resp = await fetch(
    `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(3000) },
  );
  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    Answer?: Array<{ type: number; data: string; TTL: number }>;
  };
  if (!data.Answer) return null;

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
    if (n < 0 || n > 255) throw new Error(`Invalid IPv4 octet: ${p}`);
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

/**
 * CF IPv4 ranges as [start, end] uint32 pairs.
 * Source: https://www.cloudflare.com/ips/
 */
const CF_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = (() => {
  const toU32 = (ip: string): number => {
    const p = ip.split(".").map(Number);
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  };
  return [
    [toU32("173.245.48.0"), toU32("173.245.63.255")], // /20
    [toU32("103.21.244.0"), toU32("103.21.247.255")], // /22
    [toU32("103.22.200.0"), toU32("103.22.203.255")], // /22
    [toU32("103.31.4.0"), toU32("103.31.7.255")], // /22
    [toU32("141.101.64.0"), toU32("141.101.127.255")], // /18
    [toU32("108.162.192.0"), toU32("108.162.255.255")], // /18
    [toU32("190.93.240.0"), toU32("190.93.255.255")], // /20
    [toU32("188.114.96.0"), toU32("188.114.111.255")], // /20
    [toU32("197.234.240.0"), toU32("197.234.243.255")], // /22
    [toU32("198.41.128.0"), toU32("198.41.255.255")], // /17
    [toU32("162.158.0.0"), toU32("162.159.255.255")], // /15
    [toU32("104.16.0.0"), toU32("104.27.255.255")], // /12
    [toU32("172.64.0.0"), toU32("172.71.255.255")], // /13
    [toU32("131.0.72.0"), toU32("131.0.75.255")], // /22
  ] as const;
})();

/**
 * CF IPv6 prefixes (first 32 bits).
 * All CF IPv6 ranges are /32 or larger, so prefix matching is sufficient.
 */
const CF_IPV6_PREFIXES = [
  "2400:cb00", // 2400:cb00::/32
  "2606:4700", // 2606:4700::/32
  "2803:f800", // 2803:f800::/32
  "2405:8100", // 2405:8100::/32
  "2a06:98c0", // 2a06:98c0::/29
  "2c0f:f248", // 2c0f:f248::/32
] as const;

function ipv4ToUint32(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function isCloudflareIPv4(ipv4: string): boolean {
  const num = ipv4ToUint32(ipv4);
  return CF_IPV4_RANGES.some(([start, end]) => num >= start && num <= end);
}

export function isCloudflareIPv6(ipv6: string): boolean {
  const lower = ipv6.toLowerCase();
  return CF_IPV6_PREFIXES.some(prefix => lower.startsWith(prefix));
}

export interface CfCheckResult {
  isCf: boolean;
  ipv4: string | null;
  ipv6: string | null;
  dnsMs: number;
  /** Minimum TTL from A/AAAA records (seconds). 0 if no records found. */
  ttl: number;
}

interface DnsJsonResponse {
  Answer?: Array<{ type: number; data: string; TTL: number }>;
}

/**
 * Resolve hostname via DoH (parallel A + AAAA), check if IP is in CF ranges.
 * Used to pre-detect CF CDN targets that need NAT64 bypass.
 */
export async function resolveAndCheckCloudflare(hostname: string): Promise<CfCheckResult> {
  const t0 = Date.now();
  const dnsSignal = AbortSignal.timeout(3000);
  const [aResp, aaaaResp] = await Promise.all([
    fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { Accept: "application/dns-json" },
      signal: dnsSignal,
    }),
    fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=AAAA`, {
      headers: { Accept: "application/dns-json" },
      signal: dnsSignal,
    }),
  ]);
  const dnsMs = Date.now() - t0;

  let ipv4: string | null = null;
  let ipv6: string | null = null;
  let isCf = false;
  const ttls: number[] = [];

  if (aResp.ok) {
    const data = (await aResp.json()) as DnsJsonResponse;
    const aRecord = data.Answer?.find(r => r.type === 1);
    if (aRecord) {
      ipv4 = aRecord.data;
      ttls.push(aRecord.TTL);
      if (isCloudflareIPv4(ipv4)) isCf = true;
    }
  }

  if (aaaaResp.ok) {
    const data = (await aaaaResp.json()) as DnsJsonResponse;
    const aaaaRecord = data.Answer?.find(r => r.type === 28);
    if (aaaaRecord) {
      ipv6 = aaaaRecord.data;
      ttls.push(aaaaRecord.TTL);
      if (isCloudflareIPv6(ipv6)) isCf = true;
    }
  }

  const ttl = ttls.length > 0 ? Math.min(...ttls) : 0;
  return { isCf, ipv4, ipv6, dnsMs, ttl };
}
