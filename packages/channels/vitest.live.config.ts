import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["live-tests/*.test.ts"],
    // Every scenario clears the same provider-owned destinations.
    fileParallelism: false,
    testTimeout: 300_000
  }
});
