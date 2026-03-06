/**
 * stealth-fetch/lite: Lightweight HTTP/1.1 client for Cloudflare Workers.
 * Platform TLS only — no WASM, no NAT64 fallback, no DoH detection.
 * Use when bundle size is critical (CF Workers Free 3MB limit).
 */
import { createRequestFn } from "../web/client.js";

export const request = createRequestFn(); // No strategy → default h1RequestDirect

export type { RequestOptions, RetryOptions, HttpResponse } from "../web/client.js";
export { toWebResponse } from "../compat/web.js";
export { parseUrl } from "../utils/url.js";
export type { ParsedUrl } from "../utils/url.js";
