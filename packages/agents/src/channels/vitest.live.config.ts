import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "channels-live",
    include: ["live-tests/*.test.ts"],
    // Every scenario clears the same provider-owned destinations.
    fileParallelism: false,
    testTimeout: 660_000
  }
});
