/**
 * E2E test: multi-pass fiber recovery for a sub-agent (facet).
 *
 * The root parent owns the physical alarm; a facet child's orphaned fibers are
 * recovered by the parent re-driving the child's scan across alarm passes (the
 * facet-run lease is retained while the child still has rows). A tiny child
 * scan deadline forces several passes. Covers the gap that the root-DO recovery
 * tests don't exercise the facet recovery path under multi-pass churn.
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
const PORT = 18824;
const PERSIST_DIR = path.join(__dirname, ".wrangler-e2e-facet-multipass");
const harness: Harness = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR
};

const PARENT_NAME = "facet-multipass-e2e";
const PARENT_PATH = `/agents/facet-recovery-parent/${PARENT_NAME}`;
const CHILD_NAME = "facet-child";
const FIBER_COUNT = 20;

type ChildScanStatus = {
  runCount: number;
  hookCount: number;
  distinctRecovered: number;
  scanDeadlineExceededCount: number;
};

async function getChildStatus(): Promise<ChildScanStatus> {
  return (await callAgentByPath(harness, PARENT_PATH, "getChildScanStatus", [
    CHILD_NAME
  ])) as ChildScanStatus;
}

describe("facet multi-pass recovery e2e", () => {
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

  it("recovers every facet-child fiber across multiple parent-driven passes", async () => {
    wrangler = startWrangler(harness);
    await waitForReady(harness);

    await callAgentByPath(harness, PARENT_PATH, "startChildManyFibers", [
      CHILD_NAME,
      FIBER_COUNT,
      30
    ]);
    await sleep(3500);

    const before = await getChildStatus();
    expect(before.runCount).toBe(FIBER_COUNT);
    expect(before.hookCount).toBe(0);

    // SIGKILL the whole isolate (parent + facet) and restart against the same
    // persist dir. The parent alarm re-drives the child's recovery.
    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree(harness);
    wrangler = startWrangler(harness);
    await waitForReady(harness);

    let sawDeadlineYield = false;
    let fullyRecovered = false;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      let status: ChildScanStatus;
      try {
        status = await getChildStatus();
      } catch {
        continue;
      }
      console.log(
        `[test] poll ${i + 1}: child runCount=${status.runCount}, ` +
          `distinctRecovered=${status.distinctRecovered}, ` +
          `scanDeadlineExceeded=${status.scanDeadlineExceededCount}`
      );
      if (status.scanDeadlineExceededCount >= 1) sawDeadlineYield = true;
      if (status.runCount === 0 && status.distinctRecovered === FIBER_COUNT) {
        fullyRecovered = true;
        break;
      }
    }

    // The child scan yielded at least once (proof it took multiple passes) and
    // the parent-driven recovery eventually drained every child fiber.
    expect(sawDeadlineYield).toBe(true);
    expect(fullyRecovered).toBe(true);

    const final = await getChildStatus();
    expect(final.runCount).toBe(0);
    expect(final.distinctRecovered).toBe(FIBER_COUNT);
    expect(final.hookCount).toBe(FIBER_COUNT);
  });
});
