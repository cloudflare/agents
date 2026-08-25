import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "channels",
    include: ["src/channels/__tests__/**/*.test.ts"]
  }
});
