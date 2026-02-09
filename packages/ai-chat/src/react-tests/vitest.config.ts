import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "react",
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
