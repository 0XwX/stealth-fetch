import { describe, it, expect } from "vitest";

/**
 * Verify that the lite entry module's import graph does NOT reach
 * DoH/NAT64/WASM modules. We read source files as raw text to check
 * import statements — this validates the architecture at source level.
 *
 * Root tsup uses `bundle: false`, so dist mirrors src structure exactly.
 * If src/lite/index.ts only imports from client.ts and client.ts has no
 * DoH/NAT64 imports, the lite dist will be clean.
 */

describe("stealth-fetch/lite — no WASM/DoH gate", () => {
  it("src/lite/index.ts should only import from client.ts, compat/web, utils/url", async () => {
    const content = (await import("../../../src/lite/index.ts?raw")).default;

    // Should import from these modules only
    expect(content).toContain("../web/client.js");
    expect(content).toContain("../compat/web.js");
    expect(content).toContain("../utils/url.js");

    // Should NOT import from DoH/NAT64/WASM modules
    expect(content).not.toContain("full-strategy");
    expect(content).not.toContain("wasm-transport");
    expect(content).not.toContain("wasm-tls");
    expect(content).not.toContain("nat64");
    expect(content).not.toContain("dns-cache");
  });

  it("src/web/client.ts should not import DoH/NAT64 modules (pure shell)", async () => {
    const content = (await import("../../../src/web/client.ts?raw")).default;

    // Extract only import lines — client.ts was refactored to be a pure shell
    const importLines = content
      .split("\n")
      .filter((line: string) => /^\s*import\s/.test(line))
      .join("\n");

    expect(importLines).not.toContain("nat64");
    expect(importLines).not.toContain("dns-cache");
    expect(importLines).not.toContain("full-strategy");
    expect(importLines).not.toContain("wasm-transport");
    expect(importLines).not.toContain("cloudflare-ranges");
  });

  it("lite module should not re-export DoH/NAT64 symbols", async () => {
    const mod = await import("../../../src/lite/index.js");

    // These should only exist in the full web entry, not lite
    expect(mod).not.toHaveProperty("prewarmDns");
    expect(mod).not.toHaveProperty("clearDnsCache");
    expect(mod).not.toHaveProperty("clearNat64PrefixStats");
    expect(mod).not.toHaveProperty("createFullStrategy");
  });
});
