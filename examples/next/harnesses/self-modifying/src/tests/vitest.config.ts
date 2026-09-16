import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") }
    })
  ],
  test: {
    name: "self-modifying-harness",
    include: [path.join(testsDir, "**/*.test.ts")],
    // Each turn bundles source and boots Dynamic Workers; a cold cache is
    // slow enough that the default budget is not enough.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
