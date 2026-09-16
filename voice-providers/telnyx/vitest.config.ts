import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "agents/voice/errors": fileURLToPath(
        new URL("../../packages/agents/src/voice/errors.ts", import.meta.url)
      )
    }
  },
  test: {
    retry: 3,
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
