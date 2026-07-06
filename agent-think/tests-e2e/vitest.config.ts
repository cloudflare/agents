import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * E2E vitest config. Runs against a live `wrangler dev --local` process
 * (started by `./setup.ts`), not inside the pool-workers Miniflare
 * runtime. Tests issue real HTTP requests over the network and drive a real
 * docker container + Workspace.
 *
 * Slow (~30s+ boot for cold docker, then minutes for a real model turn). Kept
 * separate from the default vitest run so `npm test` stays fast.
 */
const testDir = import.meta.dirname;

export default defineConfig({
  test: {
    include: [path.join(testDir, "**/*.test.ts")],
    globalSetup: path.join(testDir, "setup.ts"),
    testTimeout: 60_000,
    hookTimeout: 240_000,
    pool: "forks"
  }
});
