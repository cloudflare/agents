import { defineConfig } from "vitest/config";

/**
 * E2E vitest config. Runs against a live `wrangler dev --local` process
 * (started by `tests-e2e/setup.ts`), not inside the pool-workers Miniflare
 * runtime. Tests issue real HTTP requests over the network and drive a real
 * docker container + Workspace.
 *
 * Slow (~30s+ boot for cold docker, then minutes for a real model turn). Kept
 * separate from the default vitest run so `npm test` stays fast.
 */
export default defineConfig({
  test: {
    include: ["tests-e2e/**/*.test.ts"],
    globalSetup: "./tests-e2e/setup.ts",
    testTimeout: 60_000,
    hookTimeout: 240_000,
    pool: "forks"
  }
});
