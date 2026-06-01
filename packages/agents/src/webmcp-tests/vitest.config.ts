import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    name: "webmcp",
    retry: 3,
    browser: {
      enabled: true,
      instances: [{ browser: "chromium", headless: true }],
      provider: playwright()
    },
    clearMocks: true
  }
});
