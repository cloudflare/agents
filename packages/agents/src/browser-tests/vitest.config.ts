import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "browser",
    retry: 3,
    // Stop after the first test fails all its retries. This suite spawns a real
    // `wrangler dev` + local Browser Rendering simulator; if the environment
    // degrades (e.g. a corrupted Chrome download), bailing turns what was a
    // silent run to the CI job's 30-minute cancel into a fast, reported failure
    // instead of grinding every test through retry:3 × the 120s timeout.
    bail: 1,
    include: [path.join(import.meta.dirname, "**/*.test.ts")],
    testTimeout: 120_000,
    hookTimeout: 60_000
  }
});
