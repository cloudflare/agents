import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "browser",
    // No retries: a failure is a bug in the product or the test.
    retry: 0,
    // Stop after the first failure. This suite spawns a real `wrangler dev` +
    // local Browser Rendering simulator; if the environment degrades (e.g. a
    // corrupted Chrome download), bailing turns what was a silent run to the
    // CI job's 30-minute cancel into a fast, reported failure instead of
    // grinding every test through the 120s timeout.
    bail: 1,
    include: [path.join(import.meta.dirname, "**/*.test.ts")],
    testTimeout: 120_000,
    hookTimeout: 60_000
  }
});
