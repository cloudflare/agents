import { defineConfig } from "vitest/config";
import { lowerEsDecorators } from "./vitest.plugins.js";

export default defineConfig({
  plugins: [lowerEsDecorators()],
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/adapters/cloudflare/**", "**/node_modules/**"],
    environment: "node",
    testTimeout: 15_000
  }
});
