import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8799;
const e2eDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(e2eDir, "wrangler.jsonc");

export default defineConfig({
  testDir: e2eDir,
  testMatch: "*.spec.ts",
  timeout: 30_000,
  retries: 3,
  workers: 1, // Sequential — single wrangler dev instance
  use: {
    baseURL: `http://localhost:${PORT}`
  },
  webServer: {
    // Kill stale processes on the port before starting wrangler.
    // This must be part of the command (not globalSetup) because
    // Playwright starts the webServer before running globalSetup.
    command: `lsof -ti tcp:${PORT} | xargs kill -9 2>/dev/null; npx wrangler dev --config ${configPath} --port ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000
  }
});
