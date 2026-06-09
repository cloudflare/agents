import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "create-think",
    environment: "node",
    clearMocks: true,
    include: ["src/tests/**/*.test.ts"]
  }
});
