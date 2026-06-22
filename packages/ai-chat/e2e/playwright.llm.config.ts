import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Workers-AI ai-chat e2e suite — exercises real model streaming, server-side
 * tool calls, client tools and the onChatResponse hook against a live model.
 *
 * Split out from the deterministic suite (`playwright.config.ts`) because it
 * requires the remote `ai` binding (`wrangler.jsonc`) and a healthy connection
 * to the Workers AI edge. Real-model latency/flakiness is bounded here by a hard
 * `globalTimeout` so this job can never silently run to the CI 30-minute cancel.
 */
const PORT = 8798;
const e2eDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(e2eDir, "wrangler.jsonc");

export default defineConfig({
  testDir: e2eDir,
  testMatch: [
    "llm.spec.ts",
    "on-stream-end-llm.spec.ts",
    "client-tools.spec.ts",
    "advanced-client-tools.spec.ts"
  ],
  // Real model turns are slower than mock streams.
  timeout: 90_000,
  // Hard wall-clock cap, below the CI job's 30-minute ceiling, so flaky/slow
  // Workers AI fails WITH a report instead of being canceled with none.
  globalTimeout: 20 * 60_000,
  // Real-model output is nondeterministic — the small Workers AI model
  // occasionally varies wording/step boundaries and trips a strict assertion.
  // Re-runs recover these reliably, so allow extra retries (only fire on
  // failure, so green runs pay nothing).
  retries: process.env.CI ? 3 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`
  },
  webServer: {
    command: `lsof -ti tcp:${PORT} | xargs kill -9 2>/dev/null; npx wrangler dev --config ${configPath} --port ${PORT} --inspector-port 0`,
    // Wait for the worker to actually serve — i.e. once the remote `ai`
    // connection is established and `wrangler dev` is past
    // "Establishing remote connection...". A port-only check would race ahead
    // and every spec would fail with a WebSocket error.
    url: `http://localhost:${PORT}/__health`,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    // Generous: establishing the remote connection can take a while.
    timeout: 90_000
  }
});
