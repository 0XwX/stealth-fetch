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

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `Unsupported protocol: ${parsed.protocol} (only http: and https: are supported)`,
    );
  }

  const protocol = parsed.protocol === "https:" ? "https" : "http";
  const hostname = parsed.hostname;
  const defaultPort = protocol === "https" ? 443 : 80;
  const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
  const path = parsed.pathname + parsed.search;

  return { protocol, hostname, port, path: path || "/" };
}

/** Return hostname:port only if port is non-default for the protocol */
export function hostWithPort(hostname: string, port: number, protocol: "https" | "http"): string {
  const defaultPort = protocol === "https" ? 443 : 80;
  return port === defaultPort ? hostname : `${hostname}:${port}`;
}
