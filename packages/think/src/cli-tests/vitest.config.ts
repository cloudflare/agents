import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "think-cli",
    environment: "node",
    clearMocks: true,
    include: ["src/cli-tests/**/*.test.ts"]
  }
});
