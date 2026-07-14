/**
 * Ported from: packages/think/src/e2e-tests/chat-recovery.test.ts
 * Original last-change commit: 1c8fdf58
 * Port date: 2026-07-14
 *
 * Modifications:
 * - Replaced the original inlined wrangler/WebSocket/process helpers with the
 *   shared e2e harness from ./harness.js.
 * - Kept the original agent class names and URL slugs; the fixture worker
 *   normalizes the original E2E acronym slug to the rebuild router.
 * - Moved the persist directory under the ported e2e folder.
 */

/**
 * E2E test: Think chat recovery after process eviction.
 *
 * 1. Start wrangler dev with ThinkRecoveryE2EAgent
 * 2. Send a chat message via WebSocket (starts a slow stream inside runFiber)
 * 3. Kill the process mid-stream (SIGKILL — simulates real DO eviction)
 * 4. Restart wrangler with the same persist directory
 * 5. Verify: onChatRecovery fired, partial text persisted, fiber row cleaned up
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  callAgentByPath,
  killProcess,
  killProcessOnPort,
  pollUntil,
  restartWrangler,
  sendChatMessage,
  sendChatMessageAndWaitForDone,
  sleep,
  startWrangler,
  waitForPortFree,
  waitForReady,
  type StartWranglerOptions
} from "./harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18797;
const AGENT_NAME = "think-recovery-e2e";
const AGENT_SLUG = "think-recovery-e2-e-agent";
const HELPER_PARENT_NAME = "think-helper-recovery-e2e";
const HELPER_PARENT_SLUG = "think-recovery-helper-parent";
const HELPER_NAME = "helper-recovery-e2e";
const PERSIST_DIR = path.join(__dirname, ".wrangler-think-recovery-e2e-state");
const AGENT_PATH = `/agents/${AGENT_SLUG}/${AGENT_NAME}`;
const HELPER_PARENT_PATH = `/agents/${HELPER_PARENT_SLUG}/${HELPER_PARENT_NAME}`;

const WRANGLER_OPTS: StartWranglerOptions = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR,
  cwd: __dirname,
  agentPath: AGENT_PATH
};

type RecoveryStatus = {
  recoveryCount: number;
  contexts: Array<{
    streamId: string;
    requestId: string;
    partialText: string;
  }>;
  messageCount: number;
  assistantMessages: number;
};

type AgentToolRunStatus = {
  runId: string;
  status: string;
  error: string | null;
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

async function callHelperParent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return callAgentByPath(HELPER_PARENT_PATH, method, args);
}

async function waitForAgentRecovery(): Promise<RecoveryStatus> {
  return pollUntil(
    "agent recovery",
    () => callAgent("getRecoveryStatus") as Promise<RecoveryStatus>,
    (status) => status.recoveryCount > 0
  );
}

async function waitForHelperRecovery(): Promise<RecoveryStatus> {
  return pollUntil(
    "helper recovery",
    () =>
      callHelperParent("getHelperRecoveryStatus", [
        HELPER_NAME
      ]) as Promise<RecoveryStatus>,
    (status) => status.recoveryCount > 0
  );
}

async function waitForAgentToolRun(
  runId: string,
  predicate: (run: AgentToolRunStatus) => boolean
): Promise<AgentToolRunStatus> {
  const rows = await pollUntil(
    "agent-tool recovery",
    () => callHelperParent("getAgentToolRuns") as Promise<AgentToolRunStatus[]>,
    (runs) => runs.some((run) => run.runId === runId && predicate(run)),
    { attempts: 40, delayMs: 500 }
  );
  const row = rows.find((run) => run.runId === runId);
  if (!row) throw new Error(`Missing agent-tool row ${runId}`);
  return row;
}

describe("Think chat recovery e2e", () => {
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

  it("should recover chat after process kill via persisted alarm", async () => {
    // 1. Start wrangler
    wrangler = startWranglerForTest();
    await waitForReady();

    // 2. Send a chat message (starts slow stream inside runFiber)
    await sendChatMessage("Tell me a long story");

    // 3. Wait for a few chunks to stream
    // ResumableStream flushes chunks in batches. Wait long enough for the
    // slow mock model to cross the flush threshold before killing workerd, so
    // recovery sees a non-empty partial response instead of only a fiber row.
    await sleep(6000);

    // Verify fiber row exists (stream is in progress)
    const hasFibers = (await callAgent("hasFiberRows")) as boolean;
    console.log(`[test] Fiber rows before kill: ${hasFibers}`);

    // 4. Kill the process mid-stream
    console.log("[test] Killing wrangler (SIGKILL)...");
    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree();

    // 5. Restart wrangler with the same persist directory
    console.log("[test] Restarting wrangler...");
    wrangler = startWranglerForTest();
    await waitForReady();
    console.log("[test] Wrangler restarted");

    // 6. Wait for alarm to fire and recovery to complete
    let recovered = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const status = (await callAgent("getRecoveryStatus")) as {
          recoveryCount: number;
          messageCount: number;
          assistantMessages: number;
        };
        console.log(
          `[test] Poll ${i + 1}: recovered=${status.recoveryCount}, messages=${status.messageCount}, assistant=${status.assistantMessages}`
        );
        if (status.recoveryCount > 0) {
          recovered = true;
          break;
        }
      } catch {
        console.log(`[test] Poll ${i + 1}: error (agent not ready)`);
      }
    }

    // 7. Verify recovery
    expect(recovered).toBe(true);

    const status = (await callAgent("getRecoveryStatus")) as {
      recoveryCount: number;
      contexts: Array<{
        streamId: string;
        requestId: string;
        partialText: string;
      }>;
      messageCount: number;
      assistantMessages: number;
    };

    expect(status.recoveryCount).toBeGreaterThanOrEqual(1);
    // Partial text should contain some chunks that streamed before the kill
    expect(status.contexts[0]?.partialText.length ?? 0).toBeGreaterThan(0);

    // Recovery schedules a continuation that re-runs the turn in a fresh fiber,
    // so a fiber row legitimately exists *while* that turn streams. Poll until
    // it settles rather than racing the in-flight continuation.
    const fiberRowsAfter = await pollUntil(
      "agent fiber cleanup",
      () => callAgent("hasFiberRows") as Promise<boolean>,
      (has) => has === false
    );
    expect(fiberRowsAfter).toBe(false);
  });

  it("should still recover after repeated restart churn around an interrupted turn", async () => {
    wrangler = startWranglerForTest();
    await waitForReady();

    await sendChatMessage("Tell me a long restart story");
    await sleep(6000);

    expect((await callAgent("hasFiberRows")) as boolean).toBe(true);

    for (let i = 0; i < 2; i++) {
      console.log(`[test] Restart churn cycle ${i + 1}`);
      wrangler = await restartWranglerForTest(wrangler);
      // Keep this intentionally short: the test approximates deploy churn where
      // a fresh isolate can be replaced before recovery work settles.
      await sleep(250);
    }

    const status = await waitForAgentRecovery();
    expect(status.contexts[0]?.partialText.length ?? 0).toBeGreaterThan(0);

    // Recovery schedules a continuation that re-runs the turn in a fresh fiber,
    // so a fiber row legitimately exists *while* that turn streams. Poll until
    // it settles rather than racing the in-flight continuation.
    const fiberRowsAfter = await pollUntil(
      "agent fiber cleanup",
      () => callAgent("hasFiberRows") as Promise<boolean>,
      (has) => has === false
    );
    expect(fiberRowsAfter).toBe(false);
  });

  it("should expose the current post-persist chat request failure surface", async () => {
    wrangler = startWranglerForTest();
    await waitForReady();

    await callAgent("throwBeforeNextTurn", ["forced beforeTurn failure"]);

    const response = await sendChatMessageAndWaitForDone(
      "Persist this, then fail before the model turn"
    );
    expect(response.error).toBe(true);
    expect(response.body).toContain("forced beforeTurn failure");

    const status = (await callAgent("getRecoveryStatus")) as RecoveryStatus;
    expect(status.messageCount).toBe(1);
    expect(status.assistantMessages).toBe(0);

    // This documents the observability gap from the report: the request catch
    // broadcasts a chat error frame, but it does not route through onError.
    expect((await callAgent("getOnErrorLog")) as string[]).toEqual([]);
    const chatErrorLog = await pollUntil(
      "chat error hook",
      () => callAgent("getOnChatErrorLog") as Promise<string[]>,
      (log) => log.some((entry) => entry.includes("forced beforeTurn failure")),
      { attempts: 10, delayMs: 250 }
    );
    expect(chatErrorLog).toContain("forced beforeTurn failure");
  });

  it("should recover helper sub-agent chat after process kill via parent alarm", async () => {
    wrangler = startWranglerForTest();
    await waitForReady();

    await callHelperParent("startHelperChatTurn", [
      HELPER_NAME,
      "Tell me a helper story"
    ]);

    const hasFibers = (await callHelperParent("helperHasFiberRows", [
      HELPER_NAME
    ])) as boolean;
    console.log(`[test] Helper fiber rows before kill: ${hasFibers}`);
    expect(hasFibers).toBe(true);

    console.log("[test] Killing wrangler (SIGKILL)...");
    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree();

    console.log("[test] Restarting wrangler...");
    wrangler = startWranglerForTest();
    await waitForReady();
    console.log("[test] Wrangler restarted");

    const status = await waitForHelperRecovery();

    expect(status.recoveryCount).toBeGreaterThanOrEqual(1);
    expect(status.contexts[0]?.partialText.length ?? 0).toBeGreaterThan(0);

    // Recovery schedules a continuation that re-runs the turn in a fresh fiber,
    // so a fiber row legitimately exists *while* that turn streams. Poll until
    // it settles rather than racing the in-flight continuation.
    const fiberRowsAfter = await pollUntil(
      "helper fiber cleanup",
      () =>
        callHelperParent("helperHasFiberRows", [
          HELPER_NAME
        ]) as Promise<boolean>,
      (has) => has === false
    );
    expect(fiberRowsAfter).toBe(false);
  });

  it("should re-attach to a still-running child agent-tool run after parent restart and collect its terminal result (#1630)", async () => {
    wrangler = startWranglerForTest();
    await waitForReady();

    const runId = `agent-tool-${Date.now()}`;
    await callHelperParent("startHelperAgentToolRun", [
      runId,
      "Tell me an agent-tool story"
    ]);

    await waitForAgentToolRun(
      runId,
      (run) => run.status === "starting" || run.status === "running"
    );

    console.log("[test] Killing wrangler with active agent-tool run...");
    wrangler = await restartWranglerForTest(wrangler);

    // #1630 progress-keyed re-attach: a deploy that interrupts an in-flight
    // child no longer abandons it as `interrupted`. The parent re-attaches to
    // the still-running child (the facet self-heals via `continue` recovery)
    // and tails it to its REAL terminal — collecting `completed`. The child
    // streams ~10s of chunks, so allow a generous window for it to settle.
    const recoveredRun = await pollUntil(
      "agent-tool re-attach terminal",
      () =>
        callHelperParent("getAgentToolRuns") as Promise<AgentToolRunStatus[]>,
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

    expect(recoveredRun).toBeDefined();
    // The re-attached, self-healing child reaches its real terminal — it is NOT
    // abandoned as `interrupted` the way the old flat-budget behavior did.
    expect(recoveredRun?.status).toBe("completed");
    expect(recoveredRun?.error ?? null).toBeNull();
  });
});
