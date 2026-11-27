import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "nightly-upgrade",
    include: [path.join(import.meta.dirname, "upgrade.test.ts")],
    // No retries: a failure is a bug in the product or the suite.
    retry: 0,
    // Two deploys, one npm install of the release, then the live rows drain.
    hookTimeout: 900_000,
    testTimeout: 300_000
  }
});
