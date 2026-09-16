import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "harnessd-claude-code",
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
});
