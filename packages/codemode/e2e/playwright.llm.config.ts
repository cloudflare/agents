import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Workers-AI codemode e2e suite — exercises the full LLM pipeline (user prompt →
 * model generates code → DynamicWorkerExecutor → sandboxed Worker → tool
 * dispatch → result) for codemode.spec.ts (/run) and llm-codemode.spec.ts
 * (/run-multi, /types/multi).
 *
 * Split out from the deterministic suite (playwright.config.ts) because it
 * requires the remote `ai` binding (wrangler.jsonc) and a healthy Workers AI
 * edge connection. Real-model latency/flakiness is bounded by a hard
 * `globalTimeout` so this job can never silently run to a CI job's hard cancel.
 * Mirrors the ai-chat playwright.llm.config.ts.
 */
const PORT = 8799;
const e2eDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(e2eDir, "wrangler.jsonc");

export default defineConfig({
  testDir: e2eDir,
  testMatch: ["codemode.spec.ts", "llm-codemode.spec.ts"],
  // Real model turns are slower than the deterministic executor specs.
  timeout: 90_000,
  globalTimeout: 15 * 60_000,
  // Real-model output is nondeterministic — the small Workers AI model
  // occasionally varies wording and trips a strict assertion. Re-runs recover
  // these reliably, so allow extra retries (only fire on failure).
  retries: process.env.CI ? 3 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`
  },
  webServer: {
    command: `lsof -ti tcp:${PORT} | xargs kill -9 2>/dev/null; npx wrangler dev --config ${configPath} --port ${PORT} --inspector-port 0`,
    // Wait for the worker to actually serve — i.e. once the remote `ai`
    // connection is established and `wrangler dev` is past "Establishing remote
    // connection...". A port-only check would race ahead and every spec would
    // fail before the remote binding is ready.
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 90_000
  }
});
