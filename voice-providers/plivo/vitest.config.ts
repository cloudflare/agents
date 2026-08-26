import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@cloudflare/voice/errors": fileURLToPath(
        new URL("../../packages/voice/src/errors.ts", import.meta.url)
      )
    }
  },
  test: {
    retry: 3,
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
