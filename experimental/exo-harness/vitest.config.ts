import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // Decorator transform for @callable() in src/server.ts.
    agents(),
    cloudflareTest({
      wrangler: {
        configPath: path.join(import.meta.dirname, "src/tests/wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "exo-harness",
    include: ["src/tests/**/*.test.ts"],
    testTimeout: 20_000
  }
});
