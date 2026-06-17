import path from "node:path";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

// OPT-IN deployed recovery suite. Runs ONLY the deployed test, deploys real
// Workers, and is never part of the default `test` / `test:e2e` runs. Invoke via
// `RUN_DEPLOYED_E2E=1 pnpm --filter @cloudflare/ai-chat test:e2e:deployed`.
export default defineConfig({
  test: {
    name: "ai-chat-e2e-deployed",
    // A retry re-runs the full deploy -> evict -> recover cycle, so keep it low.
    retry: 1,
    include: [path.join(testsDir, "deployed-recovery.test.ts")],
    testTimeout: 600_000,
    hookTimeout: 200_000,
    teardownTimeout: 130_000,
    fileParallelism: false
  }
});
