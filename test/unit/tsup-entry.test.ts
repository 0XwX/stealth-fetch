import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob<T>(
      pattern: string,
      options: { eager: true; import: "default"; query: "?raw" },
    ): Record<string, T>;
  }
}

const tsupConfigModules = import.meta.glob<string>("../../tsup.config.ts", {
  eager: true,
  import: "default",
  query: "?raw",
});
const sourceModules = import.meta.glob<string>("../../src/**/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
});

describe("tsup entry allowlist", () => {
  it("should include every publishable source module and exclude generated wasm TS", () => {
    const [tsupConfigSource] = Object.values(tsupConfigModules);
    if (tsupConfigSource === undefined) {
      throw new Error("tsup.config.ts source was not loaded");
    }

    const configuredEntries = extractConfiguredEntries(tsupConfigSource);
    const publishableSources = Object.keys(sourceModules)
      .map(toRepoPath)
      .filter(path => !path.endsWith(".d.ts"))
      .filter(path => !path.startsWith("src/socket/wasm-pkg/"))
      .sort();

    const missingEntries = publishableSources.filter(path => !configuredEntries.includes(path));
    const extraEntries = configuredEntries.filter(path => !publishableSources.includes(path));

    expect(configuredEntries).not.toContain("src/socket/wasm-pkg/wasm_tls_bg.b64.ts");
    expect(missingEntries).toEqual([]);
    expect(extraEntries).toEqual([]);
  });
});

function extractConfiguredEntries(source: string): string[] {
  return [...source.matchAll(/"((?:src)\/[^"]+\.ts)"/g)].map(match => match[1]).sort();
}

function toRepoPath(path: string): string {
  return path.replace(/^\.\.\//, "").replace(/^\.\.\//, "");
}
