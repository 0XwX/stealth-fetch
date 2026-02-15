/**
 * Worker example for stealth-fetch/web (no nodejs_compat).
 *
 * Endpoints:
 *   GET  /                    → Usage info
 *   GET  /exports             → Verify all public APIs are exported
 *   GET  /get?url=            → HTTP GET via stealth-fetch/web
 *   POST /post?url=           → POST with body forwarding
 *   GET  /headers?url=        → Show upstream-received headers (verify no cf-*)
 *   GET  /redirect            → Test redirect following (httpbin /redirect/3)
 *   GET  /compress            → Test gzip decompression (httpbin /gzip)
 *   GET  /fetch-compare?url=  → Compare fetch vs stealth-fetch headers
 *   GET  /cpu-test            → Minimal single-request CPU benchmark
 *   ANY  /ai/{provider}/{path}  → AI API proxy via stealth-fetch/web
 */
import {
  request,
  parseUrl,
  clearDnsCache,
  clearNat64PrefixStats,
  toWebResponse,
  prewarmDns,
} from "../src/web/index.js";

import { NAT64_PREFIXES, ipv4ToNAT64, resolveAndCheckCloudflare } from "../src/socket/nat64.js";
import { connectWasmTls, preloadWasmTls } from "../src/web/wasm-tls.js";

// ── AI Proxy ──

const AI_PROVIDERS: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  groq: "https://api.groq.com",
  mistral: "https://api.mistral.ai",
  xai: "https://api.x.ai",
  openrouter: "https://openrouter.ai",
  together: "https://api.together.xyz",
  deepseek: "https://api.deepseek.com",
};

async function handleAIProxy(req: Request, path: string): Promise<Response> {
  const match = path.match(/^\/ai\/([^/]+)(\/.*)?$/);
  if (!match) return jsonResponse({ error: "Invalid AI proxy path" }, 400);

  const provider = match[1];
  const rest = match[2] || "/";
  const baseUrl = AI_PROVIDERS[provider];
  if (!baseUrl) {
    return jsonResponse(
      { error: `Unknown provider: ${provider}`, available: Object.keys(AI_PROVIDERS) },
      404,
    );
  }

  const incomingUrl = new URL(req.url);
  const targetUrl = `${baseUrl}${rest}${incomingUrl.search}`;
  const hasBody = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  // Buffer body as Uint8Array so request() can retry/hedge NAT64 prefixes
  // (ReadableStream body disables hedging since it can't be replayed)
  const bodyData = hasBody && req.body ? new Uint8Array(await req.arrayBuffer()) : null;

  try {
    const upstream = await request(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: bodyData,
      timeout: 60000,
      redirect: "follow",
    });

    const responseHeaders = new Headers();
    for (const [name, value] of upstream.rawHeaders) {
      if (
        !["transfer-encoding", "connection", "content-encoding", "content-length"].includes(
          name.toLowerCase(),
        )
      ) {
        responseHeaders.append(name, value);
      }
    }
    responseHeaders.set("x-proxy-provider", provider);
    responseHeaders.set("x-proxy-protocol", upstream.protocol);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    return jsonResponse(
      {
        error: isTimeout ? "Upstream request timeout" : "Upstream request failed",
        detail: message,
        provider,
        target: targetUrl,
      },
      isTimeout ? 504 : 502,
    );
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ── /exports ──
      if (path === "/exports") {
        return jsonResponse({
          request: typeof request,
          prewarmDns: typeof prewarmDns,
          parseUrl: typeof parseUrl,
          clearDnsCache: typeof clearDnsCache,
          clearNat64PrefixStats: typeof clearNat64PrefixStats,
          toWebResponse: typeof toWebResponse,
        });
      }

      // ── /get?url= ──
      if (path === "/get") {
        const target = url.searchParams.get("url");
        if (!target) return jsonResponse({ error: "Missing ?url= parameter" }, 400);

        const t0 = Date.now();
        const response = await request(target, {
          headers: { "User-Agent": "stealth-fetch-web/1.0" },
          timeout: 15000,
        });
        const body = await response.text();

        return jsonResponse({
          status: response.status,
          protocol: response.protocol,
          timeMs: Date.now() - t0,
          bodyLength: body.length,
          bodyPreview: body.substring(0, 500),
        });
      }

      // ── /post?url= ──
      if (path === "/post") {
        const target = url.searchParams.get("url");
        if (!target) return jsonResponse({ error: "Missing ?url= parameter" }, 400);

        const reqBody = await req.text();
        const t0 = Date.now();
        const response = await request(target, {
          method: "POST",
          headers: {
            "User-Agent": "stealth-fetch-web/1.0",
            "Content-Type": req.headers.get("content-type") || "application/json",
          },
          body: reqBody,
          timeout: 15000,
        });
        const body = await response.text();

        return jsonResponse({
          status: response.status,
          protocol: response.protocol,
          timeMs: Date.now() - t0,
          bodyLength: body.length,
          bodyPreview: body.substring(0, 500),
        });
      }

      // ── /headers?url= ── Show what upstream sees (verify no cf-* injection)
      if (path === "/headers") {
        const target = url.searchParams.get("url") || "https://httpbin.org/headers";

        const response = await request(target, {
          headers: { "User-Agent": "stealth-fetch-web/1.0" },
          timeout: 15000,
        });
        const body = await response.json();

        return jsonResponse({
          info: "Headers seen by upstream (should NOT contain cf-* headers)",
          upstreamSaw: body,
        });
      }

      // ── /redirect ── Test redirect following
      if (path === "/redirect") {
        const count = url.searchParams.get("n") || "3";
        const target = `https://httpbin.org/redirect/${count}`;

        const t0 = Date.now();
        const response = await request(target, {
          headers: { "User-Agent": "stealth-fetch-web/1.0" },
          redirect: "follow",
          timeout: 15000,
        });
        const body = await response.json();

        return jsonResponse({
          info: `Followed ${count} redirects`,
          finalStatus: response.status,
          timeMs: Date.now() - t0,
          finalBody: body,
        });
      }

      // ── /compress ── Test gzip decompression
      if (path === "/compress") {
        const t0 = Date.now();
        const response = await request("https://httpbin.org/gzip", {
          headers: { "User-Agent": "stealth-fetch-web/1.0" },
          decompress: true,
          timeout: 15000,
        });
        const body = await response.json();

        return jsonResponse({
          info: "Gzip decompression test",
          status: response.status,
          timeMs: Date.now() - t0,
          decompressedBody: body,
        });
      }

      // ── /fetch-compare?url= ── Compare fetch vs stealth-fetch
      if (path === "/fetch-compare") {
        const target = url.searchParams.get("url") || "https://httpbin.org/headers";

        // Standard fetch (includes cf-* headers)
        const fetchResponse = await fetch(target, {
          headers: { "User-Agent": "stealth-fetch-web/1.0" },
        });
        const fetchBody = await fetchResponse.json();

        // stealth-fetch/web (should NOT include cf-* headers)
        const stealthResponse = await request(target, {
          headers: { "User-Agent": "stealth-fetch-web/1.0" },
          timeout: 15000,
        });
        const stealthBody = await stealthResponse.json();

        return jsonResponse({
          info: "Compare headers: fetch (with cf-*) vs stealth-fetch (without cf-*)",
          fetch: fetchBody,
          stealthFetch: stealthBody,
        });
      }

      // ── /cpu-test ── Minimal CPU benchmark: single stealth-fetch request
      if (path === "/cpu-test") {
        const t0 = Date.now();
        console.debug("[cpu-test] start");

        const tReq = Date.now();
        const response = await request("https://httpbin.org/headers", {
          headers: { "User-Agent": "stealth-fetch-web/cpu-test" },
          timeout: 15000,
        });
        const reqMs = Date.now() - tReq;

        const tBody = Date.now();
        const body = await response.text();
        const bodyMs = Date.now() - tBody;

        console.debug(`[cpu-test] request=${reqMs}ms body=${bodyMs}ms total=${Date.now() - t0}ms`);
        return jsonResponse({
          info: "CPU benchmark: single stealth-fetch/web request",
          status: response.status,
          protocol: response.protocol,
          timeMs: Date.now() - t0,
          bodyLength: body.length,
        });
      }

      // ── /nat64-test ── Test all NAT64 prefixes against a CF CDN host
      if (path === "/nat64-test") {
        const host = url.searchParams.get("host") || "api.openai.com";
        const perTimeout = parseInt(url.searchParams.get("timeout") || "5000", 10);
        const cfCheck = await resolveAndCheckCloudflare(host);
        if (!cfCheck.ipv4) {
          return jsonResponse({ error: `DNS resolution failed for ${host}`, cfCheck }, 502);
        }
        preloadWasmTls();
        const results: Array<{
          index: number;
          prefix: string;
          addr: string;
          ok: boolean;
          ms: number;
          alpn?: string | null;
          error?: string;
        }> = [];
        for (let i = 0; i < NAT64_PREFIXES.length; i++) {
          const prefix = NAT64_PREFIXES[i];
          const addr = ipv4ToNAT64(cfCheck.ipv4, prefix);
          const t0 = Date.now();
          try {
            const sock = await connectWasmTls(
              host,
              443,
              ["h2", "http/1.1"],
              addr,
              AbortSignal.timeout(perTimeout),
            );
            const ms = Date.now() - t0;
            results.push({ index: i, prefix, addr, ok: true, ms, alpn: sock.negotiatedAlpn });
            sock.close();
          } catch (err) {
            const ms = Date.now() - t0;
            results.push({
              index: i,
              prefix,
              addr,
              ok: false,
              ms,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const working = results.filter(r => r.ok).sort((a, b) => a.ms - b.ms);
        return jsonResponse({
          host,
          ipv4: cfCheck.ipv4,
          isCf: cfCheck.isCf,
          total: results.length,
          working: working.length,
          failed: results.length - working.length,
          bestMs: working[0]?.ms ?? null,
          results,
        });
      }

      // ── /ai/{provider}/{path} ── AI API proxy
      if (path.startsWith("/ai/")) {
        return handleAIProxy(req, path);
      }

      // ── / ── Usage info
      return new Response(
        [
          "stealth-fetch/web example (no nodejs_compat)",
          "",
          "GET  /exports             → Verify public API exports",
          "GET  /get?url=            → HTTP GET via stealth-fetch/web",
          "POST /post?url=           → POST with body forwarding",
          "GET  /headers?url=        → Show upstream headers (verify no cf-*)",
          "GET  /redirect?n=3        → Test redirect following",
          "GET  /compress            → Test gzip decompression",
          "GET  /fetch-compare?url=  → Compare fetch vs stealth-fetch headers",
          "GET  /cpu-test            → Minimal single-request CPU benchmark",
          "ANY  /ai/{provider}/{path} → AI API proxy via stealth-fetch/web",
          "",
        ].join("\n"),
        { headers: { "Content-Type": "text/plain" } },
      );
    } catch (err) {
      return jsonResponse(
        {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        500,
      );
    }
  },
};
