import path from "node:path";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  test: {
    name: "ai-chat-e2e",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 120_000,
    hookTimeout: 60_000
  }
});
