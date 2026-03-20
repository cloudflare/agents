import path from "node:path";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const testsDir = import.meta.dirname;

export default defineConfig({
  define: {
    "globalThis.IS_REACT_ACT_ENVIRONMENT": true
  },
  test: {
    name: "react",
    include: [path.join(testsDir, "**/*.test.{ts,tsx}")],
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
    clearMocks: true
  }
});
