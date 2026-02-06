import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.d.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  bundle: false,
  outDir: "dist",
  external: ["cloudflare:sockets", "hpack.js"],
});
