import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    retry: 3,
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
