/**
 * stealth-fetch/web: HTTP/1.1 client for Cloudflare Workers
 * without nodejs_compat, via cloudflare:sockets.
 *
 * Full entry point — injects WASM TLS transport for NAT64 fallback.
 */
import { createRequestFn } from "./client.js";
import { createFullStrategy, prewarmDns } from "./full-strategy.js";
import { createWasmTransport } from "./wasm-transport.js";

// Main API — factory with full strategy (DoH + NAT64 + WASM TLS)
export const request = createRequestFn(createFullStrategy(createWasmTransport()));
export { prewarmDns };
export type { RequestOptions, RetryOptions, HttpResponse, PrewarmDnsOptions } from "./client.js";
export { toWebResponse } from "../compat/web.js";

// DNS cache / NAT64 health (advanced usage)
export { clearDnsCache, clearNat64PrefixStats } from "./full-strategy.js";

// Protocol utilities
export { parseUrl } from "../utils/url.js";
export type { ParsedUrl } from "../utils/url.js";
