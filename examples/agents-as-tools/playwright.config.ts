import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the `agents-as-tools` example.
 *
 * Default mode: boots `vite dev` on port 5173 in the background, points
 * Playwright at it, and runs against a real Workers AI binding (`ai`
 * binding has `remote: true` in `wrangler.jsonc`, so even the dev
 * server hits the real model). Tests are slow but high-fidelity:
 * actual WS frames, actual DO routing, actual LLM tool selection.
 *
 * No CI integration is wired — the user's stated workflow is to run
 * this locally. To run on CI we'd need:
 *   - `playwright install --with-deps chromium`
 *   - A Workers AI auth shape (env var or `wrangler login` + the
 *     account being addressable from CI)
 *   - Whatever flake budget shows up (real LLMs are non-deterministic;
 *     prompts are biased to pick specific tools but a flake-retry
 *     count > 0 will eventually be needed)
 *
 * Concurrency:
 *   - `workers: 1`. Each test exercises a single Assistant DO that
 *     accumulates state (helper rows, registry rows). Running them
 *     in parallel against the same dev server's DOs would interleave
 *     state in confusing ways. The dev server itself is fine to share;
 *     the cost is throughput, which we trade for clarity.
 *
 * Timeouts:
 *   - Each test gets 90s. Real LLM responses can take 5-30s, and a
 *     test like "research → drill-in → assert side panel renders" can
 *     easily chain three of those.
 *   - Per-action default of 5s is too short for waiting on streamed
 *     content; we override to 30s on the slow assertions.
 */

const PORT = Number(process.env.PORT ?? 5173);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts/,
  // Real-LLM timing — see the comment block above. The example
  // uses `@cf/moonshotai/kimi-k2.5`, a heavyweight reasoning model.
  // A single helper turn pairs a parent-side LLM call (tool
  // selection) with a helper-side LLM call (the helper's own
  // inference loop), so 60-120s per test is realistic. The compare
  // tool runs two helpers in parallel which doubles that. 180s
  // gives a comfortable margin without being so long that a real
  // hang waits forever.
  timeout: 180_000,
  expect: {
    // Long enough to wait through a slow first-token latency on
    // Workers AI without wedging on a real-but-flaked test.
    timeout: 60_000
  },
  // Don't share state across tests via parallel workers — see above.
  fullyParallel: false,
  workers: 1,
  // Real Workers AI occasionally returns 504 Gateway Timeout (the
  // upstream model is slow/overloaded). With `retries: 0` a single
  // 504 fails the run, which is too brittle for a real-LLM e2e
  // suite. With 1 retry we can ride out transient capacity issues
  // while still surfacing actual regressions on the second attempt.
  // Bump to 0 if you want to debug a "real" failure without retry
  // masking it.
  retries: process.env.E2E_NO_RETRY ? 0 : 1,
  reporter: process.env.CI ? "list" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Capture artifacts for debugging the inevitable LLM-flaked test
    // run. Cleared between successful runs by Playwright's default
    // `output-folder/` rotation.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  // Auto-boot `vite dev` before tests. `agents-as-tools`'s `npm start`
  // resolves to `vite dev`, which the @cloudflare/vite-plugin upgrades
  // into a workerd-running dev server with the real `ai` binding
  // (`remote: true` in wrangler.jsonc).
  webServer: {
    command: "npm start",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
