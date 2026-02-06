# stealth-fetch

HTTP/1.1 + HTTP/2 client for Cloudflare Workers built on `cloudflare:sockets`.
It avoids automatic `cf-*` header injection by using raw TCP sockets.

## Highlights

- HTTP/1.1 + HTTP/2 with ALPN negotiation
- WASM TLS (rustls) for TLS 1.2/1.3 + ALPN control
- HTTP/2 connection pooling and protocol cache
- NAT64 fallback for blocked outbound connections
- Redirects, retries, and timeouts
- Raw headers preserved (order + multi-value)

## Install

```bash
pnpm add stealth-fetch
```

## Usage

```typescript
import { request } from "stealth-fetch";

const response = await request("https://api.example.com/v1/data", {
  method: "POST",
  headers: {
    Authorization: "Bearer sk-...",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-4",
    messages: [{ role: "user", content: "Hello" }],
  }),
});

const data = await response.json();
console.log(data);
```

## Web Response Compatibility

If you need a standard Web `Response` object (with `bodyUsed`, `clone`, `text`,
`json`, etc.), convert with `toWebResponse()`:

```typescript
import { request, toWebResponse } from "stealth-fetch";

const resp = await request("https://httpbin.org/headers", { protocol: "h2" });
const webResp = toWebResponse(resp);
const text = await webResp.text();
```

Note: don’t call `resp.text()/json()/arrayBuffer()` before converting, or the
body stream will already be consumed.

If you need a pre-cloned pair (using `ReadableStream.tee()`), pass
`{ tee: true }`:

```typescript
const { response, clone } = toWebResponse(resp, { tee: true });
```

## API

### `request(url, options?)`

Returns `Promise<HttpResponse>`.

**Options**

| Option           | Type                                                         | Default    | Description                                                                   |
| ---------------- | ------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------- |
| `method`         | `string`                                                     | `'GET'`    | HTTP method                                                                   |
| `headers`        | `Record<string, string>`                                     | `{}`       | Request headers                                                               |
| `body`           | `string \| Uint8Array \| ReadableStream<Uint8Array> \| null` | `null`     | Request body                                                                  |
| `protocol`       | `'h2' \| 'http/1.1' \| 'auto'`                               | `'auto'`   | Protocol selection                                                            |
| `timeout`        | `number`                                                     | `30000`    | Overall timeout from call until response headers (includes retries/redirects) |
| `headersTimeout` | `number`                                                     | —          | Timeout waiting for response headers                                          |
| `bodyTimeout`    | `number`                                                     | —          | Idle timeout waiting for response body data                                   |
| `signal`         | `AbortSignal`                                                | —          | Cancellation signal                                                           |
| `redirect`       | `'follow' \| 'manual'`                                       | `'follow'` | Redirect handling                                                             |
| `maxRedirects`   | `number`                                                     | `5`        | Max redirects to follow                                                       |
| `decompress`     | `boolean`                                                    | `true`     | Auto-decompress gzip/deflate responses                                        |
| `compressBody`   | `boolean`                                                    | `false`    | Gzip-compress request body (Uint8Array > 1KB)                                 |

**Response**

```typescript
interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  rawHeaders: ReadonlyArray<[string, string]>;
  protocol: "h2" | "http/1.1";
  body: ReadableStream<Uint8Array>;

  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  getSetCookie(): string[];
}
```

### Advanced APIs

```typescript
import {
  Http2Client,
  Http2Connection,
  http1Request,
  clearPool,
  preconnect,
  createWasmTLSSocket,
} from "stealth-fetch";
```

- `Http2Client` — HTTP/2 client with stream multiplexing
- `Http2Connection` — Low-level HTTP/2 connection
- `http1Request(socket, request)` — HTTP/1.1 over a raw socket
- `clearPool()` — Clear the HTTP/2 connection pool
- `preconnect(hostname, port?)` — Pre-establish an HTTP/2 connection
- `createWasmTLSSocket(hostname, port, alpnList)` — WASM TLS socket with ALPN

## Differences From `fetch`

- `fetch` injects `cf-*` headers in Workers, this library does not.
- `fetch` exposes standard `Request/Response` objects; this library returns a
  custom `HttpResponse` (use `toWebResponse()` if you need a Web `Response`).
- Protocol control (force `h1`/`h2`, ALPN, NAT64) is supported here.

## NAT64 Fallback Notes

NAT64 is a best-effort fallback. Public NAT64 gateways can be unstable or
blocked depending on region and routing, so some connections may fail. If you
rely on NAT64, plan for retries or fallback behavior in your application.

## Requirements

- Cloudflare Workers runtime
- `nodejs_compat` compatibility flag

## Example Worker

The repo includes a minimal worker at `examples/worker.ts` with endpoints:

- `/http1`
- `/http2`
- `/auto`
- `/fetch`
- `/single?url=&mode=auto|h1|h2|fetch`

`wrangler.toml` points to `examples/worker.ts` as the entry.

## Development

```bash
pnpm dev          # Local dev server (wrangler)
pnpm test:run     # Run tests once
pnpm test         # Run tests in watch mode
pnpm type-check   # TypeScript type check
pnpm build        # Build to dist/
pnpm lint         # ESLint
pnpm format       # Prettier
```

## Contributing

See `CONTRIBUTING.md` for commit message rules and dev notes.

## Building WASM TLS

Requires Rust toolchain with `wasm-pack` and `wasm32-unknown-unknown` target:

```bash
pnpm build:wasm
```

## License

[Apache-2.0](LICENSE)
