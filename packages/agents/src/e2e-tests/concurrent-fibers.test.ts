/**
 * E2E test: concurrent fiber recovery.
 *
 * Existing eviction tests only recover a single fiber at a time. This starts N
 * concurrent fibers (a mix of managed + unmanaged), SIGKILLs mid-flight, and
 * asserts EVERY one is recovered after restart: `onFiberRecovered` fires once
 * per fiber, all orphan rows are cleaned up, and managed fibers reach their
 * terminal state.
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
const PORT = 18822;
const PERSIST_DIR = path.join(__dirname, ".wrangler-e2e-concurrent");
const harness: Harness = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR
};

const AGENT_NAME = "concurrent-fibers-e2e";
const AGENT_PATH = `/agents/concurrent-fiber-agent/${AGENT_NAME}`;
const UNMANAGED_COUNT = 3;
const MANAGED_COUNT = 2;
const TOTAL = UNMANAGED_COUNT + MANAGED_COUNT;

type ConcurrentStatus = {
  runCount: number;
  hookCount: number;
  distinctRecovered: number;
};

type Inspection = {
  status: string;
  idempotencyKey?: string;
} | null;

async function getStatus(): Promise<ConcurrentStatus> {
  return (await callAgentByPath(
    harness,
    AGENT_PATH,
    "getConcurrentStatus"
  )) as ConcurrentStatus;
}

async function getManagedKeyStatus(key: string): Promise<Inspection> {
  return (await callAgentByPath(harness, AGENT_PATH, "getManagedKeyStatus", [
    key
  ])) as Inspection;
}

describe("concurrent fiber recovery e2e", () => {
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

  it("recovers every one of N concurrent fibers after a process kill", async () => {
    wrangler = await startAndWait();

    await callAgentByPath(harness, AGENT_PATH, "startConcurrentFibers", [
      UNMANAGED_COUNT,
      MANAGED_COUNT,
      30
    ]);
    await sleep(3500);

    const before = await getStatus();
    expect(before.runCount).toBe(TOTAL);
    expect(before.hookCount).toBe(0);

    wrangler = await killAndRestart();

    let fullyRecovered = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      let status: ConcurrentStatus;
      try {
        status = await getStatus();
      } catch {
        continue;
      }
      console.log(
        `[test] poll ${i + 1}: runCount=${status.runCount}, ` +
          `distinctRecovered=${status.distinctRecovered}`
      );
      if (status.runCount === 0 && status.distinctRecovered === TOTAL) {
        fullyRecovered = true;
        break;
      }
    }

    expect(fullyRecovered).toBe(true);

    // Every fiber recovered exactly once; all orphan rows cleaned up.
    const final = await getStatus();
    expect(final.runCount).toBe(0);
    expect(final.distinctRecovered).toBe(TOTAL);
    expect(final.hookCount).toBe(TOTAL);

    // Managed fibers reached their terminal (completed) state via recovery.
    for (let n = 0; n < MANAGED_COUNT; n++) {
      const key = `concurrent-managed-${n}`;
      const inspection = await getManagedKeyStatus(key);
      expect(inspection).not.toBeNull();
      expect(inspection?.status).toBe("completed");
      expect(inspection?.idempotencyKey).toBe(key);
    }
  });
});
