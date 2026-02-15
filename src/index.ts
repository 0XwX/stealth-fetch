/**
 * stealth-fetch: HTTP/1.1 + HTTP/2 client for Cloudflare Workers
 * via cloudflare:sockets, bypassing cf-* header injection.
 */

// Main API
export { request, preconnect, prewarmDns } from "./client.js";
export type { RequestOptions, RetryOptions, HttpResponse, PrewarmDnsOptions } from "./client.js";
export { toWebResponse } from "./compat/web.js";

// HTTP/2 client (advanced usage)
export { Http2Client } from "./http2/client.js";
export { Http2Connection } from "./http2/connection.js";
export type { ConnectionOptions } from "./http2/connection.js";

// HTTP/1.1 client (advanced usage)
export { http1Request } from "./http1/client.js";
export type { Http1Request, Http1Response } from "./http1/client.js";

// Socket layer (advanced usage)
export { CloudflareSocketAdapter } from "./socket/adapter.js";
export { WasmTlsSocketAdapter } from "./socket/wasm-tls-adapter.js";
export {
  createTLSSocket,
  createPlainSocket,
  createSocket,
  createWasmTLSSocket,
} from "./socket/tls.js";

// Connection pool (advanced usage)
export { clearPool } from "./connection-pool.js";

// DNS cache (advanced usage)
export { clearDnsCache } from "./dns-cache.js";
export { clearNat64PrefixStats } from "./socket/nat64-health.js";

// Protocol utilities
export { parseUrl } from "./utils/url.js";
export type { ParsedUrl } from "./utils/url.js";
