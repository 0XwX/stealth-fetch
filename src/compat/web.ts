import type { HttpResponse } from "../client.js";

export interface WebResponsePair {
  response: Response;
  clone: Response;
}

/**
 * Convert a stealth-fetch HttpResponse into a standard Web Response.
 * Note: Do not call HttpResponse.text/json/arrayBuffer before converting.
 */
export function toWebResponse(
  response: HttpResponse,
  options?: { tee?: boolean },
): Response | WebResponsePair {
  if (response.body.locked) {
    throw new Error("Cannot convert to Web Response: body stream is already locked/consumed");
  }

  const headers = new Headers();

  // Prefer rawHeaders to preserve multi-value headers (e.g., set-cookie).
  if (response.rawHeaders && response.rawHeaders.length > 0) {
    for (const [name, value] of response.rawHeaders) {
      headers.append(name, value);
    }
  } else {
    for (const [name, value] of Object.entries(response.headers)) {
      headers.set(name, value);
    }
  }

  const init = {
    status: response.status,
    statusText: response.statusText,
    headers,
  };

  if (options?.tee) {
    const [a, b] = response.body.tee();
    return {
      response: new Response(a, init),
      clone: new Response(b, init),
    };
  }

  return new Response(response.body, init);
}
