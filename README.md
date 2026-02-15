# stealth-fetch

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/stealth-fetch.svg)](https://www.npmjs.com/package/stealth-fetch)

HTTP client for Cloudflare Workers that bypasses automatic `cf-*` header
injection. Built on `cloudflare:sockets` with WASM TLS (rustls).

## Why stealth-fetch

Cloudflare Workers' built-in `fetch` automatically injects `cf-connecting-ip`,
`cf-ipcountry`, `cf-ray`, and other headers into every outbound request. These
headers reveal that requests originate from a Workers environment, which can
cause issues when proxying to third-party APIs.

stealth-fetch uses raw TCP sockets (`cloudflare:sockets`) with a WASM-compiled
TLS stack (rustls) to establish connections directly, completely bypassing the
Workers HTTP pipeline and its header injection.

## Features

- **No `cf-*` headers** --- raw socket connections bypass Workers HTTP pipeline
- **HTTP/1.1 + HTTP/2** --- ALPN negotiation with protocol caching
- **WASM TLS** --- rustls-based TLS 1.2/1.3 compiled to WebAssembly
- **NAT64 hedged retry** --- automatic fallback through multiple NAT64 prefixes
  with EWMA health scoring
- **Connection pooling** --- HTTP/2 multiplexing and connection reuse
- **Redirects, retries, timeouts** --- configurable with sensible defaults
- **Raw headers preserved** --- original order and multi-value headers
  maintained
- **Two entry points** --- `stealth-fetch` (nodejs_compat) and
  `stealth-fetch/web` (pure Web API)

## Quick Start

```bash
npm install stealth-fetch
```

```typescript
import { request } from "stealth-fetch";

const response = await request("https://api.example.com/v1/chat/completions", {
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
```

### Web Entry Point (no `nodejs_compat`)

```typescript
import { request } from "stealth-fetch/web";

const response = await request("https://httpbin.org/headers", {
  headers: { "User-Agent": "my-worker/1.0" },
});
const data = await response.json();
```

The `/web` entry uses only Web platform APIs (`cloudflare:sockets`,
`WebAssembly`, `ReadableStream`) and supports HTTP/1.1 only.

## API Reference

### `request(url, options?)`

Returns `Promise<HttpResponse>`.

**Options**

| Option           | Type                                                         | Default    | Description                                                   |
| ---------------- | ------------------------------------------------------------ | ---------- | ------------------------------------------------------------- |
| `method`         | `string`                                                     | `'GET'`    | HTTP method                                                   |
| `headers`        | `Record<string, string>`                                     | `{}`       | Request headers                                               |
| `body`           | `string \| Uint8Array \| ReadableStream<Uint8Array> \| null` | `null`     | Request body                                                  |
| `protocol`       | `'h2' \| 'http/1.1' \| 'auto'`                               | `'auto'`   | Protocol selection                                            |
| `timeout`        | `number`                                                     | `30000`    | Overall timeout (ms), includes retries and redirects          |
| `headersTimeout` | `number`                                                     | ---        | Timeout waiting for response headers                          |
| `bodyTimeout`    | `number`                                                     | ---        | Idle timeout waiting for body data                            |
| `signal`         | `AbortSignal`                                                | ---        | Cancellation signal                                           |
| `redirect`       | `'follow' \| 'manual'`                                       | `'follow'` | Redirect handling                                             |
| `maxRedirects`   | `number`                                                     | `5`        | Max redirects to follow                                       |
| `decompress`     | `boolean`                                                    | `true`     | Auto-decompress gzip/deflate                                  |
| `retry`          | `number \| RetryOptions \| false`                            | `2`        | Retry on network errors and retryable status codes            |
| `strategy`       | `'compat' \| 'fast-h1'`                                      | `'compat'` | `compat`: ALPN + h2; `fast-h1`: platform TLS for non-CF hosts |

**RetryOptions**

| Option        | Type       | Default                             | Description           |
| ------------- | ---------- | ----------------------------------- | --------------------- |
| `limit`       | `number`   | `2`                                 | Max retry attempts    |
| `methods`     | `string[]` | `GET, HEAD, OPTIONS, PUT, DELETE`   | Methods to retry      |
| `statusCodes` | `number[]` | `408, 413, 429, 500, 502, 503, 504` | Status codes to retry |
| `maxDelay`    | `number`   | `30000`                             | Max retry delay (ms)  |

**HttpResponse**

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

### `toWebResponse(response, options?)`

Converts `HttpResponse` to a standard Web `Response`. Pass `{ tee: true }` to
get a pre-cloned pair.

```typescript
import { request, toWebResponse } from "stealth-fetch";

const resp = await request("https://httpbin.org/headers");
const webResp = toWebResponse(resp);
```

### Advanced APIs

```typescript
import {
  Http2Client, // HTTP/2 client with stream multiplexing
  Http2Connection, // Low-level HTTP/2 connection
  http1Request, // HTTP/1.1 over a raw socket
  clearPool, // Clear HTTP/2 connection pool
  preconnect, // Pre-establish HTTP/2 connection
  prewarmDns, // Warm DNS and CF-detection cache
  clearNat64PrefixStats, // Reset NAT64 prefix health scores
} from "stealth-fetch";
```

## Requirements

- Cloudflare Workers runtime
- **`stealth-fetch`**: requires `nodejs_compat` compatibility flag
- **`stealth-fetch/web`**: no compatibility flags needed

## License

[Apache-2.0](LICENSE)
