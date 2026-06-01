import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    retry: 3,
    include: ["src/**/*.test.ts"]
  }
});
