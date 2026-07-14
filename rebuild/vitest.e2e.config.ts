import { defineConfig } from "vitest/config";

/**
 * Kill/restart e2e project (audit 29 T2): plain-node tests that spawn a real
 * `wrangler dev` (see e2e/harness.ts), SIGKILL it mid-work, restart against
 * the same persist dir, and drive the agent over WebSocket. Serial by design.
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    retry: 2,
  },
});
