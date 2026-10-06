import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "harness-extensions",
    environment: "node",
    include: [`${import.meta.dirname}/**/*.test.ts`]
  }
});
