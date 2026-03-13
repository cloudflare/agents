import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "shell-node",
    include: ["src/node-tests/**/*.test.ts"],
    pool: "threads",
    testTimeout: 30_000
  }
});
