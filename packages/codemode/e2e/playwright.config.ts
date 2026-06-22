import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8798;
const e2eDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(e2eDir, "wrangler.jsonc");

export default defineConfig({
  testDir: e2eDir,
  testMatch: "*.spec.ts",
  timeout: 60_000,
  // Hard wall-clock cap so a slow/flaky run (e.g. the Workers-AI llm spec) fails
  // WITH a Playwright report instead of being silently killed by a CI job's hard
  // cancel, which produces no actionable output. Mirrors the ai-chat e2e config.
  globalTimeout: 15 * 60_000,
  retries: 2,
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`
  },
  webServer: {
    command: `lsof -ti tcp:${PORT} | xargs kill -9 2>/dev/null; npx wrangler dev --config ${configPath} --port ${PORT} --inspector-port 0`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
