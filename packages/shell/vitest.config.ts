import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/spec-tests/bash/cases/**",
      "**/workers-tests/**",
      "**/node-tests/**",
      "**/browser-tests/**",
      "**/e2e/**"
    ],
    pool: "threads",
    isolate: false,
    testTimeout: 30_000
  }
});
