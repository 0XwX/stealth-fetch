/**
 * URL parsing utility.
 */

export interface ParsedUrl {
  protocol: "https" | "http";
  hostname: string;
  port: number;
  path: string; // includes query string, e.g. "/v1/chat?model=gpt-4"
}

/**
 * Parse a URL string into its components.
 * Avoids using the full URL constructor to minimize CPU overhead.
 */
export function parseUrl(url: string): ParsedUrl {
  const parsed = new URL(url);

  const protocol = parsed.protocol === "https:" ? "https" : "http";
  const hostname = parsed.hostname;
  const defaultPort = protocol === "https" ? 443 : 80;
  const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
  const path = parsed.pathname + parsed.search;

  return { protocol, hostname, port, path: path || "/" };
}
