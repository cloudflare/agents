import { defineConfig } from "vitest/config";

// Check if we should include slow tests (LLM-dependent)
const includeSlow = process.env.E2E_INCLUDE_SLOW === "true";

export default defineConfig({
  test: {
    // E2E tests run in Node.js, hitting the wrangler dev server
    environment: "node",

    // Include e2e tests, excluding slow by default
    include: includeSlow
      ? ["e2e/**/*.test.ts"]
      : ["e2e/**/*.test.ts", "!e2e/**/*.slow.test.ts"],
    exclude: includeSlow ? [] : ["e2e/**/*.slow.test.ts"],

    // Global setup/teardown for wrangler dev lifecycle
    globalSetup: ["./e2e/setup.ts"],

    // Longer timeouts for E2E tests (network, LLM calls)
    testTimeout: includeSlow ? 120000 : 60000,
    hookTimeout: 60000,

    // Run tests sequentially to avoid race conditions
    sequence: {
      concurrent: false
    },

    // Pool settings for Node environment
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true
      }
    }
  }
});
