import path from "node:path";
import { defineConfig } from "vitest/config";

const testsDir = path.join(import.meta.dirname, "src/tests");

export default defineConfig({
  test: {
    name: "messengers",
    include: [path.join(testsDir, "**/*.test.ts")]
  }
});
