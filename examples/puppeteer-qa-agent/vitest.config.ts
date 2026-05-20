import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Point @cloudflare/codemode at its source — the dist may not be built
      // in a fresh checkout, but the source is always present.
      "@cloudflare/codemode": path.resolve(
        __dirname,
        "../../packages/codemode/src/index.ts"
      ),
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  test: {
    name: "puppeteer-qa-agent",
    include: ["src/tests/**/*.test.ts"],
  },
});
