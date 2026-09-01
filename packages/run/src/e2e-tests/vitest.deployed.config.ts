import path from "node:path";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

// OPT-IN deployed run suite. Runs ONLY the deployed test, deploys a real
// Worker with a Worker Loader binding, and is never part of the default
// `test` run. Invoke via
// `RUN_DEPLOYED_E2E=1 pnpm --filter @cloudflare/run test:e2e:deployed`.
export default defineConfig({
  test: {
    name: "run-e2e-deployed",
    // A retry re-runs a failed scenario against the existing deployment.
    retry: 1,
    include: [path.join(testsDir, "deployed-run.test.ts")],
    testTimeout: 300_000,
    hookTimeout: 200_000,
    teardownTimeout: 130_000,
    fileParallelism: false
  }
});
