import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "agents/react": resolve(__dirname, "../../packages/agents/src/react.tsx"),
      agents: resolve(__dirname, "../../packages/agents/src/index.ts")
    }
  },
  test: {
    browser: {
      enabled: true,
      instances: [
        {
          browser: "chromium",
          headless: true
        }
      ],
      provider: "playwright"
    },
    clearMocks: true,
    include: ["src/**/*.test.tsx"]
  }
});
