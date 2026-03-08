import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "think-e2e",
    // Run in Node.js — we spawn wrangler as a child process
    testTimeout: 120_000,
    hookTimeout: 60_000,
    include: ["src/e2e-tests/**/*.test.ts"]
  }
});
