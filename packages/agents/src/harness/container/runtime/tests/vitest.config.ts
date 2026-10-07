import path from "node:path";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  test: {
    name: "harness-container-runtime",
    environment: "node",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 20_000
  }
});
