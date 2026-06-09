import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "think-e2e",
    // Retry flaky e2e runs (real `wrangler dev` + network) before failing.
    retry: 3,
    // Run in Node.js — we spawn wrangler as a child process
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Each file spawns `wrangler dev`; tearing down workerd + draining keep-alive
    // sockets can take a while under load. Give the pool room to terminate the
    // worker cleanly so a slow teardown doesn't fail an otherwise-green run.
    teardownTimeout: 60_000,
    fileParallelism: false,
    include: ["src/e2e-tests/**/*.test.ts"]
  }
});
