import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "think-tanstack-start-e2e",
    testTimeout: 120_000,
    hookTimeout: 90_000,
    include: ["e2e/**/*.test.ts"]
  }
});
