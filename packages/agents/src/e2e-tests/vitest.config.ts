import path from "node:path";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  test: {
    name: "e2e",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Spawns `wrangler dev`; give the pool room to terminate the worker after
    // workerd + sockets drain so a slow teardown doesn't fail a green run.
    teardownTimeout: 60_000,
    fileParallelism: false
  }
});
