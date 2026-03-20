import path from "node:path";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

// Must match TEST_WORKER_PORT in setup.ts
const TEST_WORKER_PORT = 18787;

const testsDir = import.meta.dirname;

export default defineConfig({
  define: {
    __TEST_WORKER_URL__: JSON.stringify(`http://localhost:${TEST_WORKER_PORT}`),
    "globalThis.IS_REACT_ACT_ENVIRONMENT": true
  },
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
      provider: playwright()
    },
    clearMocks: true,
    globalSetup: [path.join(testsDir, "setup.ts")],
    testTimeout: 30000,
    hookTimeout: 120000
  }
});
