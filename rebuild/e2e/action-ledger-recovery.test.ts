/**
 * Ported from: packages/think/src/e2e-tests/action-ledger-recovery.test.ts
 * Original last-change commit: 190ea814
 * Port date: 2026-07-14
 *
 * Modifications:
 * - Replaced the original inlined wrangler/WebSocket/process helpers with the
 *   shared e2e harness from ./harness.js.
 * - Moved the persist directory under the ported e2e folder.
 */

/**
 * E2E test: a crash-left `pending` action ledger row is reclaimed and re-run by
 * a later invocation across a real deploy (actions RFC pending-retry lease).
 *
 * Drives the full path inside a real `wrangler dev` runtime:
 *  1. seed the crash artifact — a stale `pending` `cf_think_action_ledger` row
 *     for an explicit-key action (exactly what a crashed mid-execute leaves)
 *  2. a real SIGKILL + restart proves the durable row survives the deploy
 *  3. a fresh chat turn calls the same action, finds the now-stale pending row,
 *     reclaims it (lease expired), and runs the side effect to completion
 *     exactly once — never stuck behind a permanent `ActionPendingError`
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
  pollUntil,
  restartWrangler,
  startWrangler,
  waitForReady,
  type StartWranglerOptions
} from "./harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18805;
const AGENT_SLUG = "think-action-ledger-recovery-e2-e-agent";
const PERSIST_DIR = path.join(
  __dirname,
  ".wrangler-think-action-ledger-e2e-state"
);

const WRANGLER_OPTS: StartWranglerOptions = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR,
  cwd: __dirname,
  agentPath: `/agents/${AGENT_SLUG}/action-ledger-deploy`
};

type LedgerRow = { key: string; status: string; updated_at: number };

function startWranglerForTest(): ChildProcess {
  return startWrangler(WRANGLER_OPTS);
}

async function restartWranglerForTest(
  child: ChildProcess
): Promise<ChildProcess> {
  return restartWrangler(child, WRANGLER_OPTS);
}

async function callAgent(
  agentName: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return callAgentByPath(`/agents/${AGENT_SLUG}/${agentName}`, method, args);
}

describe("Think action ledger pending-retry recovery e2e", () => {
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

  it("reclaims a crash-left pending ledger row after a restart", async () => {
    const agent = "action-ledger-deploy";
    const ledgerKey = "action:slowAction:ledger-recovery-key";

    wrangler = startWranglerForTest();
    await waitForReady();

    // 1. Seed the crash artifact: a stale `pending` ledger row for the
    //    explicit-key action, and confirm the side effect has not run.
    await callAgent(agent, "seedStalePendingRow");
    const seeded = (await callAgent(agent, "listLedgerRows")) as LedgerRow[];
    expect(seeded).toMatchObject([{ key: ledgerKey, status: "pending" }]);
    expect((await callAgent(agent, "getExecCount")) as number).toBe(0);

    // 2. Real deploy churn: SIGKILL + restart with the same persist dir. The
    //    pending row survives (rebuilt from the durable store on cold start).
    wrangler = await restartWranglerForTest(wrangler);

    const survived = (await callAgent(agent, "listLedgerRows")) as LedgerRow[];
    expect(survived).toMatchObject([{ key: ledgerKey, status: "pending" }]);
    expect((await callAgent(agent, "getExecCount")) as number).toBe(0);

    // 3. A fresh turn calls the same action. It finds the now-stale pending
    //    row, reclaims the lease, runs the side effect, and settles.
    const turn = (await callAgent(agent, "runLedgerActionTurn", [
      "do the ledger work"
    ])) as { done: boolean };
    expect(turn.done).toBe(true);

    // The side effect ran exactly once and the row is now settled — no
    // permanent ActionPendingError block.
    expect((await callAgent(agent, "getExecCount")) as number).toBe(1);
    const settled = (await callAgent(agent, "listLedgerRows")) as LedgerRow[];
    expect(settled).toMatchObject([{ key: ledgerKey, status: "settled" }]);

    const finalText = await pollUntil(
      "final assistant text",
      () => callAgent(agent, "getFinalText") as Promise<string>,
      (text) => text.includes("ledger action acknowledged"),
      { attempts: 20, delayMs: 1000 }
    );
    expect(finalText).toContain("ledger action acknowledged");
  });
});
