import path from "node:path";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  test: {
    name: "tanstack-recovery-e2e",
    // Retry flaky e2e runs (real `wrangler dev` + SIGKILL timing) before failing.
    retry: 3,
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
    fileParallelism: false
  }
});
