/**
 * E2E test: recovery-alarm backoff cadence for a retain-forever poison row.
 *
 * PoisonBackoffAgent sets `fiberRecoveryMaxAgeMs: 0` (retain forever) and a
 * recovery hook that always throws, so the orphaned `cf_agents_runs` row is
 * never recovered and never aged out. Without backoff the recovery follow-up
 * alarm would fire every `keepAliveIntervalMs` forever (the perpetual-heartbeat
 * hazard). This asserts the retries back off exponentially (the inter-attempt
 * gaps grow) while the row stays retained.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  type Harness,
  callAgentByPath,
  killProcess,
  killProcessOnPort,
  sleep,
  startWrangler,
  waitForPortFree,
  waitForReady
} from "./recovery-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18823;
const PERSIST_DIR = path.join(__dirname, ".wrangler-e2e-poison-backoff");
const harness: Harness = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR
};

const AGENT_NAME = "poison-backoff-e2e";
const AGENT_PATH = `/agents/poison-backoff-agent/${AGENT_NAME}`;

type BackoffStatus = {
  runCount: number;
  hookCount: number;
  hookTimestamps: number[];
};

async function getStatus(): Promise<BackoffStatus> {
  return (await callAgentByPath(
    harness,
    AGENT_PATH,
    "getBackoffStatus"
  )) as BackoffStatus;
}

describe("poison-row recovery backoff e2e", () => {
  let wrangler: ChildProcess | null = null;

  beforeEach(() => {
    killProcessOnPort(PORT);
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK
    }
  });

  afterEach(async () => {
    if (wrangler) {
      await killProcess(wrangler);
      wrangler = null;
    }
    killProcessOnPort(PORT);
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK
    }
  });

  it("backs off retries exponentially for a retain-forever poison row", async () => {
    wrangler = startWrangler(harness);
    await waitForReady(harness);

    await callAgentByPath(harness, AGENT_PATH, "startPoisonFiber", [20]);
    await sleep(3500);
    expect((await getStatus()).runCount).toBe(1);

    // SIGKILL mid-flight, then restart. The orphan survives and (because
    // maxAge is 0) is never aged out — recovery retries it forever.
    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree(harness);
    wrangler = startWrangler(harness);
    await waitForReady(harness);

    // Collect retry timestamps for ~60s. With keepAliveIntervalMs 2s the
    // backoff sequence is ~4s, 8s, 16s, 32s … so we expect a handful of
    // attempts with clearly growing gaps.
    let last: BackoffStatus = { runCount: 0, hookCount: 0, hookTimestamps: [] };
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      try {
        last = await getStatus();
      } catch {
        continue;
      }
      // The row must NEVER be dropped (retain forever) and must remain the
      // only run row — recovery never succeeds, but also never gives up.
      expect(last.runCount).toBe(1);
      if (last.hookTimestamps.length >= 4) break;
    }

    const ts = last.hookTimestamps;
    // Enough retries to measure a trend.
    expect(ts.length).toBeGreaterThanOrEqual(3);

    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) {
      gaps.push(ts[i] - ts[i - 1]);
    }
    console.log("[test] retry gaps (ms):", gaps);

    // Backoff: the gaps grow. Allow generous jitter tolerance (alarm firing is
    // not exact) but require the last gap to be clearly larger than the first —
    // i.e. the cadence is NOT a flat keepAliveIntervalMs heartbeat.
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0] * 1.5);

    // Still retained at the end (never aged out, never recovered).
    expect(last.runCount).toBe(1);
  });
});
