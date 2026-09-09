import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  define: {
    "globalThis.IS_REACT_ACT_ENVIRONMENT": true
  },
  test: {
    name: "voice-react",
    retry: 3,
    browser: {
      enabled: true,
      instances: [
        {
          browser: "chromium",
          headless: true
        }
      ],
      provider: playwright()
    },
    clearMocks: true,
    testTimeout: 30000
  }
});
