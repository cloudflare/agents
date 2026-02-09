import { defineConfig } from "vitest/config";

// Must match TEST_WORKER_PORT in setup.ts
const TEST_WORKER_PORT = 18787;

export default defineConfig({
  define: {
    // Make test worker URL available in tests
    __TEST_WORKER_URL__: JSON.stringify(`http://localhost:${TEST_WORKER_PORT}`)
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
      provider: "playwright"
    },
    clearMocks: true,
    // globalSetup starts miniflare worker for integration tests
    globalSetup: ["./setup.ts"],
    // Increase timeout for integration tests
    testTimeout: 30000,
    hookTimeout: 120000
  }
});
