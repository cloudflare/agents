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
    // A room is twelve real-model turns, two of them through a reset.
    testTimeout: 1_800_000
  }
});
