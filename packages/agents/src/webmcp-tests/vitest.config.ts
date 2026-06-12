import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

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
