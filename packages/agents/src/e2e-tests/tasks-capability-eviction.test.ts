/**
 * E2E tests: the `tasks` capability under real process eviction.
 *
 * Starts wrangler dev against a persistent state dir, begins a multi-step
 * Fiber run, SIGKILLs the whole process mid-step, restarts, and verifies:
 *
 * - completed steps replay from the journal instead of re-executing (step
 *   executions are recorded in the host's own SQLite, so instance memory
 *   dying with the process cannot fake the proof);
 * - the interrupted step runs again (at-least-once) and the run completes;
 * - a `{ run, recover }` definition routes the interruption to its recovery
 *   callback — with the interrupted step's name and last checkpoint — and
 *   the decision settles the run.
 *
 * Recovery is driven by Agent's startup dispatch: the first RPC poll after
 * restart wakes the Durable Object, whose boot recovery executes due runs
 * before user work — no manual alarm triggering.
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
  sleep,
  startWrangler,
  waitForPortFree,
  waitForReady,
  type Harness
} from "./recovery-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18826;
const HARNESS: Harness = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: path.join(__dirname, ".wrangler-tasks-capability-state")
};

const AGENT_NAME = "tasks-capability-e2e";

async function callTaskAgent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return callAgentByPath(
    HARNESS,
    `/agents/task-kill-test-agent/${AGENT_NAME}`,
    method,
    args
  );
}

async function waitForRunState(
  runId: string,
  state: string,
  maxAttempts = 30
): Promise<{ state: string; result: unknown }> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(1000);
    try {
      const current = (await callTaskAgent("getRunState", [runId])) as {
        state: string;
        result: unknown;
      } | null;
      console.log(`[test] Run poll ${i + 1}: ${runId} state=${current?.state}`);
      if (current?.state === state) return current;
    } catch {
      console.log(`[test] Run poll ${i + 1}: error (agent may not be ready)`);
    }
  }
  throw new Error(`Run ${runId} did not reach state ${state}`);
}

describe("tasks capability eviction e2e", () => {
  let wrangler: ChildProcess | null = null;

  beforeEach(() => {
    killProcessOnPort(PORT);
    try {
      fs.rmSync(HARNESS.persistDir, { recursive: true, force: true });
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
      fs.rmSync(HARNESS.persistDir, { recursive: true, force: true });
    } catch {
      // OK
    }
  });

  async function startAndWait(): Promise<ChildProcess> {
    const proc = startWrangler(HARNESS);
    await waitForReady(HARNESS);
    return proc;
  }

  async function killAndRestart(): Promise<ChildProcess> {
    console.log("[test] Killing wrangler (SIGKILL)...");
    if (wrangler) await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree(HARNESS);
    console.log("[test] Restarting wrangler...");
    const proc = startWrangler(HARNESS);
    await waitForReady(HARNESS);
    console.log("[test] Wrangler restarted");
    return proc;
  }

  it("resumes a multi-step run from its journal after SIGKILL", async () => {
    wrangler = await startAndWait();

    const runId = (await callTaskAgent("startSlowStepsRun", [8])) as string;
    expect(runId).toBe("e2e-slow-steps");

    // Let a few 1s steps commit, then kill mid-step.
    await sleep(3500);
    const before = (await callTaskAgent("getStepExecutions")) as Array<{
      step_index: number;
    }>;
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThan(8);

    wrangler = await killAndRestart();

    const completed = await waitForRunState(runId, "completed");
    expect(completed.result).toEqual({ totalSteps: 8 });

    const executions = (await callTaskAgent("getStepExecutions")) as Array<{
      step_index: number;
    }>;
    const seen = executions.map((row) => row.step_index);
    // Every step ran, and the journal prevented completed steps from
    // re-executing: at most the single interrupted step may appear twice
    // (at-least-once for the step the kill caught mid-write).
    expect(new Set(seen)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(executions.length).toBeLessThanOrEqual(9);
  });

  it("routes a killed run through its recover callback with the checkpoint", async () => {
    wrangler = await startAndWait();

    const runId = (await callTaskAgent("startGuardedRun", [8])) as string;
    expect(runId).toBe("e2e-guarded");

    await sleep(3500);
    wrangler = await killAndRestart();

    const completed = await waitForRunState(runId, "completed");
    // The recovery decision settled the run; the handler never ran again.
    expect(completed.result).toBe("recovered-e2e");

    const recoveries = (await callTaskAgent("getRecoveries")) as Array<{
      run_id: string;
      interrupted_step: string | null;
      checkpoint_json: string | null;
    }>;
    expect(recoveries.length).toBeGreaterThanOrEqual(1);
    const recovery = recoveries[0];
    expect(recovery.run_id).toBe(runId);
    expect(recovery.interrupted_step).toMatch(/^step:\d+$/);
    const checkpoint = JSON.parse(recovery.checkpoint_json ?? "null") as {
      lastStarted: number;
    };
    expect(checkpoint.lastStarted).toBeGreaterThanOrEqual(0);
    expect(String(checkpoint.lastStarted)).toBe(
      (recovery.interrupted_step ?? "").slice("step:".length)
    );
  });
});
