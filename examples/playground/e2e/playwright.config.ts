import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Port for the Vite dev server used by e2e tests (override of default 5173).
const DEV_PORT = 4173;
const e2eDir = dirname(fileURLToPath(import.meta.url));
const playgroundDir = resolve(e2eDir, "..");

export default defineConfig({
  testDir: e2eDir,
  testMatch: ["ai-runner.spec.ts"],
  timeout: 45_000,
  expect: {
    timeout: 20_000
  },
  retries: process.env.CI ? 1 : 0,
  maxFailures: process.env.CI ? 10 : undefined,
  fullyParallel: true,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${DEV_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    command: `npm run start -- --host 127.0.0.1 --port ${DEV_PORT}`,
    cwd: playgroundDir,
    port: DEV_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
