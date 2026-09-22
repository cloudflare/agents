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
    name: "next-tiny-harness",
    include: [path.join(testsDir, "**/*.test.ts")],
    // Generous, for two reasons: a durability test evicts the object and
    // replays a turn, and the retry-exhaustion test waits out a real
    // exponential backoff (~20s on its own, more when the suite is running
    // ten files in parallel).
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
