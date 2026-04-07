import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "agents-opencode",
    include: ["src/tests/**/*.test.ts"]
  }
});
