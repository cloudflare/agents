import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/.docs/**",
      "**/.plans/**",
      "**/.repos/**",
      "**/dist/**",
      "**/node_modules/**",
    ],
    include: ["src/**/*.test.ts"],
  },
});
