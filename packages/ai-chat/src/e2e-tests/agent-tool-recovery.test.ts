/**
 * E2E test: sub-agent (agent-tool) recovery after process eviction — the
 * ai-chat counterpart to Think's `chat-recovery.test.ts` "#1630 re-attach"
 * scenario, closing a parity gap (Think had sub-agent SIGKILL coverage, ai-chat
 * did not).
 *
 * A plain `Agent` parent starts an agent-tool run whose child is an
 * `AIChatAgent` (`ChatRecoveryHelperChild`). The child streams a slow finite
 * turn, so a SIGKILL lands while the run is in-flight. On restart the child
 * self-heals via continue recovery and the parent re-attaches to the still-
 * running `cf_agent_tool_runs` row, following it to its REAL terminal
 * (`completed`) rather than abandoning it as `interrupted`.
 *
 * Coverage split (mirrors Think's `reattach-budget` e2e note): this is the
 * INTEGRATION smoke for the full eviction → self-heal → re-attach loop. The
 * TIGHT regression gate for the `request_id` rebind that keeps frames
 * attributable across recovery is the deterministic Workers-pool unit suite
 * (`src/tests/agent-tool-reattach-recovery.test.ts` and
 * `src/tests/agent-tool-rebind-noop.test.ts`). We deliberately do NOT replicate
 * Think's long (>2.5min) no-progress-budget e2e here — a finite ~10s child can't
 * outlive a production no-progress budget, so it would gate nothing the unit
 * suite doesn't already cover, at a large flakiness/runtime cost.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  createWranglerHarness,
  killProcess,
  killProcessOnPort,
  pollUntil,
  rpcCall
} from "./harness";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18805;
const PERSIST_DIR = path.join(__dirname, ".wrangler-agent-tool-recovery-state");

type AgentToolRunStatus = {
  runId: string;
  status: string;
  error: string | null;
};

const harness = createWranglerHarness({
  port: PORT,
  persistDir: PERSIST_DIR,
  configPath: path.join(__dirname, "wrangler.jsonc"),
  cwd: __dirname,
  label: "agent-tool-recovery"
});

const PARENT_URL = `${harness.url}/agents/chat-recovery-helper-parent/sub-agent-recovery-e2e`;

describe("sub-agent agent-tool recovery e2e", () => {
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

  it("re-attaches to a still-running child agent-tool run after a SIGKILL and collects its terminal result (#1630)", async () => {
    wrangler = harness.start();
    await harness.waitForReady();

    const runId = `agent-tool-${Date.now()}`;
    await rpcCall(PARENT_URL, "startHelperAgentToolRun", [
      runId,
      "Tell me an agent-tool story"
    ]);

    // Wait until the parent ledger shows the child run actually in-flight, so
    // the SIGKILL is guaranteed to interrupt a live run (not a settled one).
    await pollUntil(
      "agent-tool run in-flight",
      () =>
        rpcCall(PARENT_URL, "getAgentToolRuns") as Promise<
          AgentToolRunStatus[]
        >,
      (runs) =>
        runs.some(
          (run) =>
            run.runId === runId &&
            (run.status === "starting" || run.status === "running")
        ),
      { attempts: 30, delayMs: 500 }
    );

    // Force a real isolate crash mid-run, then restart against the same persist
    // dir (the production eviction this recovery exists for).
    wrangler = await harness.restart(wrangler);

    // #1630 progress-keyed re-attach: the re-attached parent follows the
    // self-healing child to its REAL terminal instead of sealing it
    // `interrupted`. The child streams ~10s of chunks, so allow a generous
    // window for the continuation to settle.
    const recovered = await pollUntil(
      "agent-tool re-attach terminal",
      () =>
        rpcCall(PARENT_URL, "getAgentToolRuns") as Promise<
          AgentToolRunStatus[]
        >,
      (runs) =>
        runs.some(
          (run) =>
            run.runId === runId &&
            (run.status === "completed" ||
              run.status === "interrupted" ||
              run.status === "error")
        ),
      { attempts: 60, delayMs: 1000 }
    ).then((runs) => runs.find((run) => run.runId === runId));

    expect(recovered).toBeDefined();
    // The re-attached, self-healing child reaches its real terminal — it is NOT
    // abandoned as `interrupted` the way a flat-budget give-up would.
    expect(recovered?.status).toBe("completed");
    expect(recovered?.error ?? null).toBeNull();
  });
});
