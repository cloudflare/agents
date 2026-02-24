import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "react",
    include: ["**/*.test.{ts,tsx}"],
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
    setupFiles: ["./setup.ts"]
  }
});
