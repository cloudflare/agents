/**
 * E2E test: poison-row aging (fiberRecoveryMaxAgeMs → max_age_exceeded).
 *
 * An UNMANAGED runFiber whose `onFiberRecovered` always throws leaves an
 * orphaned `cf_agents_runs` row after a SIGKILL. On restart the alarm-driven
 * scan retries the recovery hook every keepAlive tick; because the hook keeps
 * throwing, the row is RETAINED for retry — until it exceeds
 * `fiberRecoveryMaxAgeMs`, at which point it is DROPPED, a `max_age_exceeded`
 * skip is emitted, and retries stop.
 *
 * PoisonRowAgent sets fiberRecoveryMaxAgeMs: 25_000 — long enough that the
 * retain/retry phase is observable after the (slower) wrangler restart, short
 * enough to expire within the test's polling window.
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
const PORT = 18820;
const PERSIST_DIR = path.join(__dirname, ".wrangler-e2e-poison");
const harness: Harness = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR
};

const AGENT_NAME = "poison-row-e2e";
const AGENT_PATH = `/agents/poison-row-agent/${AGENT_NAME}`;

type PoisonStatus = {
  runCount: number;
  hookCount: number;
  maxAgeExceededCount: number;
};

async function getStatus(): Promise<PoisonStatus> {
  return (await callAgentByPath(
    harness,
    AGENT_PATH,
    "getPoisonStatus"
  )) as PoisonStatus;
}

describe("poison-row aging e2e", () => {
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

  async function startAndWait(): Promise<ChildProcess> {
    const proc = startWrangler(harness);
    await waitForReady(harness);
    return proc;
  }

  async function killAndRestart(): Promise<ChildProcess> {
    if (wrangler) await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree(harness);
    const proc = startWrangler(harness);
    await waitForReady(harness);
    return proc;
  }

  it("retains a poison orphan row across retries, then drops it once it exceeds max age", async () => {
    wrangler = await startAndWait();

    // Start an unmanaged fiber and let it checkpoint a few steps.
    await callAgentByPath(harness, AGENT_PATH, "startPoisonFiber", [12]);
    await sleep(3500);

    const before = await getStatus();
    expect(before.runCount).toBe(1);
    expect(before.hookCount).toBe(0);

    // SIGKILL mid-flight, then restart. The orphaned row survives.
    wrangler = await killAndRestart();

    // Phase A: the row is retained while the hook keeps throwing, and recovery
    // is retried on each alarm tick (hookCount climbs while runCount stays 1).
    // Phase B: once the row exceeds maxAge it is dropped (runCount → 0) and a
    // max_age_exceeded skip is recorded.
    let sawRetainedWithRetries = false;
    let droppedHookCount = -1;
    let dropped = false;

    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      let status: PoisonStatus;
      try {
        status = await getStatus();
      } catch {
        continue;
      }
      console.log(
        `[test] poll ${i + 1}: runCount=${status.runCount}, ` +
          `hookCount=${status.hookCount}, ` +
          `maxAgeExceeded=${status.maxAgeExceededCount}`
      );

      if (status.runCount === 1 && status.hookCount >= 2) {
        // Retained AND retried at least twice while still present.
        sawRetainedWithRetries = true;
      }

      if (status.runCount === 0) {
        droppedHookCount = status.hookCount;
        expect(status.maxAgeExceededCount).toBeGreaterThanOrEqual(1);
        dropped = true;
        break;
      }
    }

    expect(sawRetainedWithRetries).toBe(true);
    expect(dropped).toBe(true);

    // Recovery stops retrying after the drop: the hook count must not grow
    // across the next couple of alarm ticks.
    await sleep(5000);
    const after = await getStatus();
    expect(after.runCount).toBe(0);
    expect(after.hookCount).toBe(droppedHookCount);
    expect(after.maxAgeExceededCount).toBeGreaterThanOrEqual(1);
  });
});
