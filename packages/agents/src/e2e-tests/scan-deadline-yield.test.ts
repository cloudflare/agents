/**
 * E2E test: scan-deadline yield (fiberRecoveryScanDeadlineMs →
 * scan_deadline_exceeded).
 *
 * ScanDeadlineAgent starts MANY orphaned unmanaged fibers and sets a tiny
 * `fiberRecoveryScanDeadlineMs` (75ms). Each recovery hook does a little work
 * (~25ms), so a single alarm pass cannot drain the whole batch — the scan
 * yields partway (emitting `scan_deadline_exceeded`) and resumes on the next
 * alarm. Across passes every fiber is eventually recovered with no starvation.
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
const PORT = 18821;
const PERSIST_DIR = path.join(__dirname, ".wrangler-e2e-scan");
const harness: Harness = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR
};

const AGENT_NAME = "scan-deadline-e2e";
const AGENT_PATH = `/agents/scan-deadline-agent/${AGENT_NAME}`;
const FIBER_COUNT = 20;

type ScanStatus = {
  runCount: number;
  hookCount: number;
  distinctRecovered: number;
  scanDeadlineExceededCount: number;
};

async function getStatus(): Promise<ScanStatus> {
  return (await callAgentByPath(
    harness,
    AGENT_PATH,
    "getScanStatus"
  )) as ScanStatus;
}

describe("scan-deadline yield e2e", () => {
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

  it("yields partway through a large batch then eventually recovers every fiber", async () => {
    wrangler = await startAndWait();

    // Start many long-running unmanaged fibers and let them checkpoint.
    await callAgentByPath(harness, AGENT_PATH, "startManyFibers", [
      FIBER_COUNT,
      30
    ]);
    await sleep(3500);

    const before = await getStatus();
    expect(before.runCount).toBe(FIBER_COUNT);
    expect(before.hookCount).toBe(0);

    wrangler = await killAndRestart();

    // Poll until every orphan is recovered. Track whether the scan ever
    // yielded (scan_deadline_exceeded) — proof that one pass did not drain
    // the whole batch.
    let sawDeadlineYield = false;
    let fullyRecovered = false;

    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      let status: ScanStatus;
      try {
        status = await getStatus();
      } catch {
        continue;
      }
      console.log(
        `[test] poll ${i + 1}: runCount=${status.runCount}, ` +
          `distinctRecovered=${status.distinctRecovered}, ` +
          `scanDeadlineExceeded=${status.scanDeadlineExceededCount}`
      );

      if (status.scanDeadlineExceededCount >= 1) {
        sawDeadlineYield = true;
      }

      if (status.runCount === 0 && status.distinctRecovered === FIBER_COUNT) {
        fullyRecovered = true;
        break;
      }
    }

    expect(sawDeadlineYield).toBe(true);
    expect(fullyRecovered).toBe(true);

    // Final state: no orphan rows, all fibers recovered exactly once (no
    // double-recovery, no starvation).
    const final = await getStatus();
    expect(final.runCount).toBe(0);
    expect(final.distinctRecovered).toBe(FIBER_COUNT);
    expect(final.hookCount).toBe(FIBER_COUNT);
    expect(final.scanDeadlineExceededCount).toBeGreaterThanOrEqual(1);
  });
});
