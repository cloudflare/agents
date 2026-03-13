import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "shell-browser",
    include: ["src/browser-tests/**/*.test.ts"],
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
    testTimeout: 30_000
  }
});
