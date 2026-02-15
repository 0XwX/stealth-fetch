/**
 * stealth-fetch/web: HTTP/1.1 client for Cloudflare Workers
 * without nodejs_compat, via cloudflare:sockets.
 */

// Main API
export { request, prewarmDns } from "./client.js";
export type { RequestOptions, RetryOptions, HttpResponse, PrewarmDnsOptions } from "./client.js";
export { toWebResponse } from "../compat/web.js";

// DNS cache (advanced usage)
export { clearDnsCache } from "../dns-cache.js";
export { clearNat64PrefixStats } from "../socket/nat64-health.js";

// Protocol utilities
export { parseUrl } from "../utils/url.js";
export type { ParsedUrl } from "../utils/url.js";
