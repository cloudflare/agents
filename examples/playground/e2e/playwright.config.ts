import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4173;
const e2eDir = dirname(fileURLToPath(import.meta.url));
const playgroundDir = resolve(e2eDir, "..");

export default defineConfig({
  testDir: e2eDir,
  testMatch: ["manual/**/*.spec.ts", "generated/**/*.spec.ts"],
  timeout: 60_000,
  expect: {
    timeout: 20_000
  },
  retries: process.env.CI ? 2 : 0,
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    command: `npm run start -- --host 127.0.0.1 --port ${PORT}`,
    cwd: playgroundDir,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
