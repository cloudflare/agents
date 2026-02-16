import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    clearMocks: true,
    include: ["src/experimental/memory/__tests__/*.test.ts"],
  },
});
