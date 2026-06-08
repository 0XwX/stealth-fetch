import { describe, expect, it } from "vitest";

describe("dist exports", () => {
  it("loads the main entry", async () => {
    const mod = await import("../../dist/index.js");
    expect(mod.request).toBeTypeOf("function");
    expect(mod.preconnect).toBeTypeOf("function");
    expect(mod.toWebResponse).toBeTypeOf("function");
  });

  it("loads the web entry", async () => {
    const mod = await import("../../dist/web/index.js");
    expect(mod.request).toBeTypeOf("function");
    expect(mod.prewarmDns).toBeTypeOf("function");
    expect(mod.toWebResponse).toBeTypeOf("function");
  });

  it("loads the lite entry", async () => {
    const mod = await import("../../dist/lite/index.js");
    expect(mod.request).toBeTypeOf("function");
    expect(mod.toWebResponse).toBeTypeOf("function");
    expect(mod.parseUrl("https://example.com/a").path).toBe("/a");
  });
});
