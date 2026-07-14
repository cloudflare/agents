/**
 * Ported from: packages/think/src/e2e-tests/tool-rollback.test.ts
 * Original last-change commit: 190ea814
 * Port date: 2026-07-14
 *
 * Modifications:
 * - Replaced the original inlined wrangler/WebSocket/process helpers with the
 *   shared e2e harness from ./harness.js.
 * - Moved the persist directory under the ported e2e folder.
 */

/**
 * E2E: rollback DEPTH under rapid kill/restart churn (tool-result durability).
 *
 * Reproduces the customer's "completed tool calls re-run / rollback past several
 * steps" report. A single long turn runs many `recordStep` tool steps; each
 * execution appends a ledger row. We SIGKILL + restart wrangler repeatedly while
 * the turn is in flight (far faster than a real ~33s deploy, matching a chaos
 * environment), then measure:
 *
 *   reRuns      = totalExecutions - uniqueIndices
 *   evictions   = recoveryCount (onChatRecovery fires once per detected eviction)
 *
 * If reRuns ≈ evictions, the framework bound holds ("at most the single
 * in-flight step re-runs per eviction") and the customer's fix is tool
 * idempotency. If reRuns >> evictions, recovery is rolling back PAST completed
 * steps — a framework reconstruction gap.
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
const PORT = 18806;
const AGENT_SLUG = "think-tool-rollback-e2-e-agent";
const AGENT_NAME = "tool-rollback-e2e";
const PERSIST_DIR = path.join(__dirname, ".wrangler-tool-rollback-state");
const TOTAL_STEPS = 30;
const AGENT_PATH = `/agents/${AGENT_SLUG}/${AGENT_NAME}`;

const WRANGLER_OPTS: StartWranglerOptions = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR,
  cwd: __dirname,
  agentPath: AGENT_PATH
};

type LedgerStatus = {
  totalExecutions: number;
  uniqueIndices: number;
  maxIndex: number;
  duplicates: Array<{ index: number; count: number }>;
  recoveryCount: number;
  assistantMessages: number;
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

async function readLedger(): Promise<LedgerStatus | null> {
  try {
    return (await callAgent("getLedgerStatus")) as LedgerStatus;
  } catch {
    return null;
  }
}

describe("tool rollback under rapid churn", () => {
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

  it("recovers a long tool loop across repeated evictions without deep rollback", async () => {
    wrangler = startWranglerForTest();
    await waitForReady();

    await sendChatMessage("seed everything in order");

    // Rapid churn while the turn runs (each cycle ~ kill + boot, a few seconds).
    for (let i = 0; i < 4; i++) {
      await sleep(2500);
      console.log(`[tool-rollback] churn cycle ${i + 1}`);
      wrangler = await restartWranglerForTest(wrangler);
    }

    // Settle: let recovery drive the loop to completion.
    let status: LedgerStatus | null = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(2500);
      status = await readLedger();
      if (status) {
        console.log(
          `[tool-rollback] poll: maxIndex=${status.maxIndex} unique=${status.uniqueIndices} total=${status.totalExecutions} recoveries=${status.recoveryCount} fibers=${status.hasFiberRows}`
        );
        if (status.maxIndex >= TOTAL_STEPS && !status.hasFiberRows) break;
      }
    }

    expect(status).not.toBeNull();
    const final = status as LedgerStatus;
    const reRuns = final.totalExecutions - final.uniqueIndices;
    const summary = {
      at: new Date().toISOString(),
      unique: final.uniqueIndices,
      totalSteps: TOTAL_STEPS,
      total: final.totalExecutions,
      reRuns,
      evictions: final.recoveryCount,
      duplicates: final.duplicates,
      assistantMessages: final.assistantMessages,
      verdict:
        final.uniqueIndices < TOTAL_STEPS
          ? "INCOMPLETE"
          : reRuns <= final.recoveryCount + 1
            ? "BOUNDED"
            : "DEEP_ROLLBACK"
    };
    console.log(`[tool-rollback] FINAL: ${JSON.stringify(summary)}`);
    try {
      fs.appendFileSync(
        "/tmp/tool-rollback.log",
        `${JSON.stringify(summary)}\n`
      );
    } catch {
      // best-effort
    }

    // Forward progress: every step eventually ran (recovery is not abandoning).
    expect(final.uniqueIndices).toBe(TOTAL_STEPS);
    // Rollback-depth bound: recovery should re-run AT MOST the single in-flight
    // step per eviction. If reRuns greatly exceeds the eviction count, recovery
    // is rolling back past already-completed steps (a framework gap).
    expect(reRuns).toBeLessThanOrEqual(final.recoveryCount + 1);
  });
});
