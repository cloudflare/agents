import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    browser: {
      provider: "playwright",
      enabled: true,
      instances: [
        {
          browser: "chromium",
          headless: true,
        },
      ],
    },
    clearMocks: true,
  },
});
