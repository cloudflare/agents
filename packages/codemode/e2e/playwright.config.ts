import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Deterministic codemode e2e suite. Drives only `executor.spec.ts`, which POSTs
 * raw code to /execute and /mcp/execute and never touches Workers AI, against an
 * AI-free worker (`wrangler.mock.jsonc`). It boots offline/instantly and needs
 * no Cloudflare credentials. The Workers-AI specs (codemode.spec.ts via /run and
 * llm-codemode.spec.ts via /run-multi) run in playwright.llm.config.ts. Mirrors
 * the ai-chat e2e split.
 */
const PORT = 8798;
const e2eDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(e2eDir, "wrangler.mock.jsonc");

export default defineConfig({
  testDir: e2eDir,
  testMatch: "executor.spec.ts",
  timeout: 60_000,
  // Hard wall-clock cap so a hang fails WITH a Playwright report instead of being
  // silently killed by a CI job's hard cancel, which produces no actionable
  // output. Mirrors the ai-chat e2e config.
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
