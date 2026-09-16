import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "channels",
    include: ["__tests__/**/*.test.ts"]
  }
});
