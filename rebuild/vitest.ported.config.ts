import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { lowerEsDecorators } from "./vitest.plugins.js";

/**
 * Ported-original-tests project (audit 29). Deliberately separate from
 * `test:workers`: ported tests are EXPECTED to fail until their triaged
 * gaps (see test-workers/ported/COVERAGE.md) are closed — failures here
 * must never turn the native suites red.
 */
export default defineConfig({
  plugins: [
    lowerEsDecorators(),
    cloudflareTest({
      wrangler: { configPath: "./test-workers/ported/wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test-workers/ported/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
