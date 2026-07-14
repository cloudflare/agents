/**
 * Ported from: packages/think/src/e2e-tests/persist-false-preserves.test.ts
 * Original last-change commit: 190ea814
 * Port date: 2026-07-14
 *
 * Modifications:
 * - Replaced the original inlined wrangler/WebSocket/process helpers with the
 *   shared e2e harness from ./harness.js.
 * - Moved the persist directory under the ported e2e folder.
 */

/**
 * E2E: `onChatRecovery` returning `{ persist: false, continue: false }` must
 * NOT drop settled tool results under a REAL process kill (#1631 / R1).
 *
 * A turn runs a `recordStep` tool loop (each execution settles a non-idempotent
 * ledger row). We let a few steps settle, SIGKILL + restart wrangler mid-turn,
 * and the agent's `onChatRecovery` returns `{ persist: false, continue: false }`
 * — the explicit "stop this turn" override. The R1 default guarantees the
 * settled tool results produced before the kill are still materialized into the
 * durable transcript (never dropped), while `continue: false` stops the turn.
 *
 * Without R1 (the old "persist:false discards the partial" behavior), the
 * transcript would have ZERO settled tool parts after recovery — so this test
 * fails on the pre-R1 code and passes after it.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  callAgentByPath,
  killProcess,
  killProcessOnPort,
  restartWrangler,
  sendChatMessage,
  sleep,
  startWrangler,
  waitForReady,
  type StartWranglerOptions
} from "./harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18807;
const AGENT_SLUG = "think-persist-false-e2-e-agent";
const AGENT_NAME = "persist-false-e2e";
const PERSIST_DIR = path.join(__dirname, ".wrangler-persist-false-state");
const TOTAL_STEPS = 30;
const AGENT_PATH = `/agents/${AGENT_SLUG}/${AGENT_NAME}`;

const WRANGLER_OPTS: StartWranglerOptions = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR,
  cwd: __dirname,
  agentPath: AGENT_PATH
};

type PersistFalseStatus = {
  totalExecutions: number;
  uniqueIndices: number;
  maxIndex: number;
  recoveryCount: number;
  assistantMessages: number;
  settledToolPartsInTranscript: number;
  hasFiberRows: boolean;
};

function startWranglerForTest(): ChildProcess {
  return startWrangler(WRANGLER_OPTS);
}

async function restartWranglerForTest(
  child: ChildProcess
): Promise<ChildProcess> {
  return restartWrangler(child, WRANGLER_OPTS);
}

async function callAgent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return callAgentByPath(AGENT_PATH, method, args);
}

async function readStatus(): Promise<PersistFalseStatus | null> {
  try {
    return (await callAgent("getPersistFalseStatus")) as PersistFalseStatus;
  } catch {
    return null;
  }
}

describe("persist:false preserves settled work under a real kill", () => {
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

  it("keeps settled tool results in the transcript when recovery returns { persist: false } (#1631 R1)", async () => {
    wrangler = startWranglerForTest();
    await waitForReady();

    await sendChatMessage("record steps in order");

    // Let a few steps settle (each ~600ms), then SIGKILL mid-turn so recovery
    // fires on restart and returns { persist: false, continue: false }.
    await sleep(3000);
    wrangler = await restartWranglerForTest(wrangler);

    // Settle: wait for recovery to fire and the turn to stop (continue:false).
    let status: PersistFalseStatus | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(2500);
      status = await readStatus();
      if (status) {
        console.log(
          `[persist-false] poll: maxIndex=${status.maxIndex} unique=${status.uniqueIndices} settledInTranscript=${status.settledToolPartsInTranscript} recoveries=${status.recoveryCount} fibers=${status.hasFiberRows}`
        );
        if (status.recoveryCount >= 1 && !status.hasFiberRows) break;
      }
    }

    expect(status).not.toBeNull();
    const final = status as PersistFalseStatus;
    console.log(`[persist-false] FINAL: ${JSON.stringify(final)}`);

    // Recovery fired and returned persist:false/continue:false.
    expect(final.recoveryCount).toBeGreaterThanOrEqual(1);
    // R1: the settled tool results produced before the kill are preserved in
    // the durable transcript (the headline guarantee). Pre-R1 this would be 0.
    expect(final.settledToolPartsInTranscript).toBeGreaterThanOrEqual(1);
    // At least one ledger step actually settled before the kill.
    expect(final.maxIndex).toBeGreaterThanOrEqual(1);
    // continue:false stopped the turn — it did NOT run to completion.
    expect(final.maxIndex).toBeLessThan(TOTAL_STEPS);
  }, 120_000);
});
