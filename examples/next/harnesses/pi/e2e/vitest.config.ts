import path from "node:path";
import { defineConfig } from "vitest/config";

const e2eDir = import.meta.dirname;

// OPT-IN deployed suite. Deploys a real Worker, so it is never part of
// `pnpm test`. Run with `RUN_DEPLOYED_E2E=1 pnpm run test:e2e:deployed`.
export default defineConfig({
  test: {
    name: "next-pi-harness-e2e-deployed",
    include: [path.join(e2eDir, "deployed.test.ts")],
    // A retry repeats a 30-minute turn; a failure here should be looked at.
    retry: 0,
    testTimeout: 55 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false
  }
});
