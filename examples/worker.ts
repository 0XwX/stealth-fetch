/**
 * Minimal Worker example for stealth-fetch.
 *
 * Endpoints:
 *   GET /http1  → HTTP/1.1 request to httpbin.org/headers
 *   GET /http2  → HTTP/2 request to httpbin.org/headers
 *   GET /auto   → Auto-negotiated request to httpbin.org/headers
 *   GET /fetch  → Standard fetch (with cf-* headers for comparison)
 *   GET /single?url=&mode=auto|h1|h2|fetch  → Single request, specified mode
 *   ANY /ai/{provider}/{path}  → AI API proxy via stealth-fetch
 */
import { request } from "../src/index.js";

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

  try {
    const upstream = await request(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? req.body : null,
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
      if (path === "/http1") {
        const response = await request("https://httpbin.org/headers", {
          protocol: "http/1.1",
          headers: { "User-Agent": "stealth-fetch-example/1.0" },
        });
        const body = await response.text();
        return jsonResponse({
          protocol: response.protocol,
          status: response.status,
          upstream_saw: JSON.parse(body),
        });
      }

      if (path === "/http2") {
        const response = await request("https://httpbin.org/headers", {
          protocol: "h2",
          headers: { "User-Agent": "stealth-fetch-example/1.0" },
        });
        const body = await response.text();
        return jsonResponse({
          protocol: response.protocol,
          status: response.status,
          upstream_saw: JSON.parse(body),
        });
      }

      if (path === "/auto") {
        const response = await request("https://httpbin.org/headers", {
          headers: { "User-Agent": "stealth-fetch-example/1.0" },
        });
        const body = await response.text();
        return jsonResponse({
          protocol: response.protocol,
          status: response.status,
          upstream_saw: JSON.parse(body),
        });
      }

      if (path === "/fetch") {
        const response = await fetch("https://httpbin.org/headers", {
          headers: { "User-Agent": "stealth-fetch-example/1.0" },
        });
        const body = await response.text();
        return jsonResponse({
          protocol: "fetch",
          status: response.status,
          upstream_saw: JSON.parse(body),
        });
      }

      if (path === "/single") {
        const target = url.searchParams.get("url");
        const mode = url.searchParams.get("mode") || "auto";
        if (!target) {
          return jsonResponse({ error: "Missing ?url= parameter" }, 400);
        }

        const t0 = Date.now();
        try {
          if (mode === "fetch") {
            const r = await fetch(target, { headers: { "User-Agent": "benchmark/1.0" } });
            const body = await r.text();
            return jsonResponse({
              mode,
              status: r.status,
              protocol: "-",
              timeMs: Date.now() - t0,
              bodyLength: body.length,
              bodyPreview: body.substring(0, 200),
            });
          }

          const proto = mode === "h1" ? "http/1.1" : mode === "h2" ? "h2" : "auto";
          const r = await request(target, {
            protocol: proto as "h2" | "http/1.1" | "auto",
            headers: { "User-Agent": "benchmark/1.0" },
            timeout: 15000,
          });
          const body = await r.text();
          return jsonResponse({
            mode,
            status: r.status,
            protocol: r.protocol,
            timeMs: Date.now() - t0,
            bodyLength: body.length,
            bodyPreview: body.substring(0, 200),
          });
        } catch (err) {
          return jsonResponse(
            {
              mode,
              error: err instanceof Error ? err.message : String(err),
              timeMs: Date.now() - t0,
            },
            500,
          );
        }
      }

      if (path.startsWith("/ai/")) {
        return handleAIProxy(req, path);
      }

      const providers = Object.keys(AI_PROVIDERS).join(", ");
      return new Response(
        `stealth-fetch example\n\nGET /http1  → HTTP/1.1 via raw socket\nGET /http2  → HTTP/2 via raw socket\nGET /auto   → Auto-negotiated via raw socket\nGET /fetch  → Standard fetch (with cf-* headers for comparison)\nGET /single?url=&mode=auto|h1|h2|fetch\n\nAI Proxy:\n  ANY /ai/{provider}/{path}  → Forward to AI API via stealth-fetch\n  Providers: ${providers}\n  Example: POST /ai/openai/v1/chat/completions\n`,
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
