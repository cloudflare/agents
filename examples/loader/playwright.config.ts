import { defineConfig, devices } from "@playwright/test";
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load .env file manually and also create .dev.vars for wrangler
 */
function loadEnvFile(): void {
  const envPath = join(process.cwd(), ".env");
  const devVarsPath = join(process.cwd(), ".dev.vars");

  if (!existsSync(envPath)) return;

  try {
    const content = readFileSync(envPath, "utf-8");

    // Copy .env to .dev.vars so wrangler can read secrets
    if (!existsSync(devVarsPath)) {
      copyFileSync(envPath, devVarsPath);
      console.log("[Playwright] Created .dev.vars from .env for wrangler");
    }

    // Also load into process.env for test skipping logic
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Remove surrounding quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      // Only set if not already in environment
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    console.log("[Playwright] Loaded .env file");
  } catch (error) {
    console.warn("[Playwright] Could not load .env file:", error);
  }
}

// Load .env before config is evaluated
loadEnvFile();

/**
 * Playwright configuration for browser E2E tests.
 *
 * These tests run against the full app (Vite dev server + wrangler dev).
 * They test user-facing UI flows like chat, streaming, tool calls, etc.
 *
 * Run with: npm run test:browser
 * Run headed: npm run test:browser:headed
 * Debug: npm run test:browser:debug
 */
export default defineConfig({
  testDir: "./browser-tests",

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry flaky tests (LLM can be unreliable)
  retries: process.env.CI ? 2 : 1,

  // Opt out of parallel tests on CI (can be flaky with server startup)
  workers: process.env.CI ? 1 : undefined,

  // Reporter
  reporter: [["html", { open: "never" }], ["list"]],

  // Shared settings for all projects
  use: {
    // Base URL for navigation
    baseURL: "http://localhost:5173",

    // Collect trace when retrying the failed test
    trace: "on-first-retry",

    // Screenshot on failure
    screenshot: "only-on-failure",

    // Video on failure (CI only to save resources)
    video: process.env.CI ? "on-first-retry" : "off"
  },

  // Configure projects for major browsers
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
    // Uncomment to test on Firefox and Safari
    // {
    //   name: "firefox",
    //   use: { ...devices["Desktop Firefox"] },
    // },
    // {
    //   name: "webkit",
    //   use: { ...devices["Desktop Safari"] },
    // },
  ],

  // Run local dev servers before tests
  webServer: [
    {
      // Start Vite dev server (frontend)
      command: "npm run start",
      url: "http://localhost:5173",
      reuseExistingServer: true, // Always reuse if a server is running
      timeout: 120 * 1000
    }
  ],

  // Global timeout for each test
  timeout: 60 * 1000,

  // Expect timeout
  expect: {
    timeout: 10 * 1000
  }
});
