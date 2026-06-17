import path from "node:path";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  test: {
    name: "ai-chat-e2e",
    // Retry flaky e2e runs (real `wrangler dev` + network) before failing.
    retry: 3,
    include: [path.join(testsDir, "**/*.test.ts")],
    // The deployed suite has its own config (`vitest.deployed.config.ts`); it
    // creates real billable Workers and must never run as part of the local
    // SIGKILL e2e.
    exclude: [path.join(testsDir, "deployed-recovery.test.ts")],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Spawns `wrangler dev`; give the pool room to terminate the worker after
    // workerd + sockets drain so a slow teardown doesn't fail a green run.
    teardownTimeout: 60_000,
    fileParallelism: false
  }
});
