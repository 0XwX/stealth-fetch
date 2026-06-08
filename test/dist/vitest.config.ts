import path from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/dist/**/*.test.ts"],
    exclude: ["node_modules/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
    poolOptions: {
      workers: {
        wrangler: { configPath: path.resolve(__dirname, "../../wrangler.toml") },
      },
    },
  },
});
