import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "nightly-faults",
    include: [path.join(import.meta.dirname, "faults.test.ts")],
    globalSetup: [path.join(import.meta.dirname, "deploy.ts")],
    // No retries: a failure is a bug in the product or the scenario.
    retry: 0,
    // Scenarios wait out stalls, backoffs and recoveries on a live Worker.
    testTimeout: 240_000,
    // Scenarios run against the deployment at once, each in its own room.
    maxConcurrency: 8
  }
});
