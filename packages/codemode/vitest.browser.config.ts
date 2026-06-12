import { playwright } from "vite-plus/test/browser-playwright";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "browser",
    retry: 3,
    include: ["src/tests/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium", headless: true }]
    }
  }
});
