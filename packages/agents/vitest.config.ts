import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "src/tests/vitest.config.ts",
      "src/react-tests/vitest.config.ts",
      "src/cli-tests/vitest.config.ts",
      "src/x402-tests/vitest.config.ts"
    ]
  }
});
