/**
 * Worker example for stealth-fetch/lite (no WASM, no DoH, no nodejs_compat).
 *
 * Minimal HTTP/1.1 client via cloudflare:sockets + platform TLS.
 * Bundle size is ~30KB vs ~400KB for the full entry.
 *
 * Endpoints:
 *   GET  /                    → Usage info
 *   GET  /exports             → Verify public API exports
 *   GET  /get?url=            → HTTP GET via stealth-fetch/lite
 *   POST /post?url=           → POST with body forwarding
 *   GET  /headers?url=        → Show upstream-received headers (verify no cf-*)
 *   GET  /redirect            → Test redirect following
 *   GET  /fetch-compare?url=  → Compare fetch vs stealth-fetch headers
 *   ANY  /ai/{provider}/{path} → AI API proxy via stealth-fetch/lite
 */
import { request, parseUrl, toWebResponse } from "../src/lite/index.js";

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
  const bodyData = hasBody && req.body ? new Uint8Array(await req.arrayBuffer()) : null;

  try {
    const upstream = await request(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: bodyData,
      timeout: 60000,
      redirect: "follow",
    });

    return toWebResponse(upstream) as Response;
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
          parseUrl: typeof parseUrl,
          toWebResponse: typeof toWebResponse,
          // lite does NOT export these (verify absence)
          prewarmDns: "not available in lite",
          clearDnsCache: "not available in lite",
          clearNat64PrefixStats: "not available in lite",
        });
      }

      // ── /get?url= ──
      if (path === "/get") {
        const target = url.searchParams.get("url");
        if (!target) return jsonResponse({ error: "Missing ?url= parameter" }, 400);

        const t0 = Date.now();
        const response = await request(target, {
          headers: { "User-Agent": "stealth-fetch-lite/1.0" },
          timeout: 15000,
        });
        const body = await response.text();

        return jsonResponse({
          entry: "stealth-fetch/lite",
          status: response.status,
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
            "User-Agent": "stealth-fetch-lite/1.0",
            "Content-Type": req.headers.get("content-type") || "application/json",
          },
          body: reqBody,
          timeout: 15000,
        });
        const body = await response.text();

        return jsonResponse({
          entry: "stealth-fetch/lite",
          status: response.status,
          timeMs: Date.now() - t0,
          bodyLength: body.length,
          bodyPreview: body.substring(0, 500),
        });
      }

      // ── /headers?url= ── Show what upstream sees (verify no cf-* injection)
      if (path === "/headers") {
        const target = url.searchParams.get("url") || "https://httpbin.org/headers";

        const response = await request(target, {
          headers: { "User-Agent": "stealth-fetch-lite/1.0" },
          timeout: 15000,
        });
        const body = await response.json();

        return jsonResponse({
          info: "Headers seen by upstream (should NOT contain cf-* headers)",
          entry: "stealth-fetch/lite",
          upstreamSaw: body,
        });
      }

      // ── /redirect ── Test redirect following
      if (path === "/redirect") {
        const count = url.searchParams.get("n") || "3";
        const target = `https://httpbin.org/redirect/${count}`;

        const t0 = Date.now();
        const response = await request(target, {
          headers: { "User-Agent": "stealth-fetch-lite/1.0" },
          redirect: "follow",
          timeout: 15000,
        });
        const body = await response.json();

        return jsonResponse({
          info: `Followed ${count} redirects`,
          entry: "stealth-fetch/lite",
          finalStatus: response.status,
          timeMs: Date.now() - t0,
          finalBody: body,
        });
      }

      // ── /fetch-compare?url= ── Compare fetch vs stealth-fetch
      if (path === "/fetch-compare") {
        const target = url.searchParams.get("url") || "https://httpbin.org/headers";

        const fetchResponse = await fetch(target, {
          headers: { "User-Agent": "stealth-fetch-lite/1.0" },
        });
        const fetchBody = await fetchResponse.json();

        const stealthResponse = await request(target, {
          headers: { "User-Agent": "stealth-fetch-lite/1.0" },
          timeout: 15000,
        });
        const stealthBody = await stealthResponse.json();

        return jsonResponse({
          info: "Compare headers: fetch (with cf-*) vs stealth-fetch/lite (without cf-*)",
          fetch: fetchBody,
          stealthFetchLite: stealthBody,
        });
      }

      // ── /ai/{provider}/{path} ── AI API proxy
      if (path.startsWith("/ai/")) {
        return handleAIProxy(req, path);
      }

      // ── / ── Usage info
      return new Response(
        [
          "stealth-fetch/lite example (no WASM, no DoH, no nodejs_compat)",
          "",
          "GET  /exports             → Verify public API exports",
          "GET  /get?url=            → HTTP GET via stealth-fetch/lite",
          "POST /post?url=           → POST with body forwarding",
          "GET  /headers?url=        → Show upstream headers (verify no cf-*)",
          "GET  /redirect?n=3        → Test redirect following",
          "GET  /fetch-compare?url=  → Compare fetch vs stealth-fetch headers",
          "ANY  /ai/{provider}/{path} → AI API proxy via stealth-fetch/lite",
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
