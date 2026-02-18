import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["tests/vitest.config.ts"]
  }
});
