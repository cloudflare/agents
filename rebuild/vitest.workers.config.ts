import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * The workerd test project (audit 27 §8-9): runs `test-workers/**` inside
 * real workerd via vitest-pool-workers (whose 0.16 API is the
 * `cloudflareTest` vite plugin), against the wrangler config that declares
 * the SQLite-backed test Durable Object classes. The plain-node suite
 * (`vitest.config.ts`) is untouched by this project.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test-workers/wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test-workers/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
