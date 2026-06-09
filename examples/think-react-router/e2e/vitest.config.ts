import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "think-react-router-e2e",
    testTimeout: 120_000,
    hookTimeout: 90_000,
    include: ["e2e/**/*.test.ts"]
  }
});
