import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "nightly-soak",
    include: [path.join(import.meta.dirname, "soak.test.ts")],
    globalSetup: [path.join(import.meta.dirname, "deploy.ts")],
    // No retries: a failure is a bug in the product or the suite.
    retry: 0,
    hookTimeout: 300_000,
    // The rooms run at once, so the soak takes as long as its slowest room:
    // twelve real-model turns, two through a reset, at most 30 minutes.
    maxConcurrency: 3,
    testTimeout: 1_800_000
  }
});
