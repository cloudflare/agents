import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "browser",
    include: [path.join(import.meta.dirname, "**/*.test.ts")],
    testTimeout: 120_000,
    hookTimeout: 60_000
  }
});
