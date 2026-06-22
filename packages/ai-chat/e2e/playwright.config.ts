import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Deterministic ai-chat e2e suite — the gating, always-green signal.
 *
 * These specs drive only mock agents (no Workers AI), so they run against the
 * AI-free `wrangler.mock.jsonc` worker, which boots offline and instantly. The
 * Workers-AI specs (llm/client-tools/on-stream-end) live in
 * `playwright.llm.config.ts`, which keeps the real remote `ai` binding. Keeping
 * the two apart means a slow/flaky Workers-AI edge connection can never sink the
 * deterministic suite — the failure mode that was canceling the nightly job at
 * its 30-minute ceiling.
 */
const PORT = 8799;
const e2eDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(e2eDir, "wrangler.mock.jsonc");

export default defineConfig({
  testDir: e2eDir,
  testMatch: [
    "chat.spec.ts",
    "data-parts.spec.ts",
    "error-recovery.spec.ts",
    "persistence-features.spec.ts",
    "resume-none.spec.ts"
  ],
  timeout: 30_000,
  // Hard wall-clock cap so a bad run fails WITH a report well before the CI job's
  // 30-minute hard cancel (which produces no actionable output). Deterministic
  // specs are fast, so 10 minutes is generous headroom.
  globalTimeout: 10 * 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Sequential — single wrangler dev instance
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`
  },
  webServer: {
    // Kill stale processes on the port before starting wrangler.
    // This must be part of the command (not globalSetup) because
    // Playwright starts the webServer before running globalSetup.
    command: `lsof -ti tcp:${PORT} | xargs kill -9 2>/dev/null; npx wrangler dev --config ${configPath} --port ${PORT} --inspector-port 0`,
    // Wait for the worker to actually serve, not just for the port to open.
    url: `http://localhost:${PORT}/__health`,
    reuseExistingServer: !process.env.CI,
    // Surface wrangler boot logs in CI so a startup failure is diagnosable.
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000
  }
});
