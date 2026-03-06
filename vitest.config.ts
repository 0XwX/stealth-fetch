import path from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  resolve: {
    alias: {
      "stealth-fetch/lite": path.resolve(__dirname, "src/lite/index.ts"),
      "stealth-fetch/web": path.resolve(__dirname, "src/web/index.ts"),
    },
  },
  test: {
    testTimeout: 60000,
    hookTimeout: 30000,
    exclude: ["node_modules/**", "dist/**", "tmp/**", "test/dist/**"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["node_modules/**", "test/**", "dist/**"],
    },
  },
});
