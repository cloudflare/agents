/**
 * Ported from: packages/think/src/e2e-tests/submission-recovery.test.ts
 * Original last-change commit: 190ea814
 * Port date: 2026-07-14
 *
 * Modifications:
 * - Replaced the original inlined wrangler/WebSocket/process helpers with the
 *   shared e2e harness from ./harness.js.
 * - Moved the persist directory under the ported e2e folder.
 */

/**
 * E2E test: Think durable-submission recovery on start.
 *
 * `_recoverSubmissionsOnStart` runs as part of the DO start sequence and
 * reconciles `running` submissions abandoned by an eviction. This test drives
 * the three recovery transitions inside a real `wrangler dev` runtime:
 *  1. messages NOT applied → re-enqueued as `pending`
 *  2. messages applied, turn NOT recoverable → `error`
 *  3. messages applied, chat turn recoverable → left running, continuation
 *     drives it to `completed`
 *
 * Cases 1 & 2 are seeded deterministically (no kill-timing race) then a process
 * restart triggers recovery. Case 3 uses a genuine in-flight submission and a
 * mid-stream SIGKILL.
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
const PORT = 18803;
const AGENT_SLUG = "think-submission-recovery-e2-e-agent";
const PERSIST_DIR = path.join(
  __dirname,
  ".wrangler-think-submission-e2e-state"
);

const WRANGLER_OPTS: StartWranglerOptions = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: PERSIST_DIR,
  cwd: __dirname,
  agentPath: `/agents/${AGENT_SLUG}/submission-not-applied`
};

type SubmissionView = { status: string; error: string | null } | null;

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

describe("Think submission recovery e2e", () => {
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

  it("re-enqueues a submission whose messages were never applied as pending", async () => {
    const agent = "submission-not-applied";
    const submissionId = "sub-not-applied";
    const requestId = "req-not-applied";

    wrangler = startWranglerForTest();
    await waitForReady();

    // Seed a `running` submission with messages_applied_at NULL and a message id
    // absent from history (the messages-not-applied path).
    await callAgent(agent, "seedRunningSubmission", [
      submissionId,
      requestId,
      false
    ]);

    // Restart: `_recoverSubmissionsOnStart` re-runs on the next DO start.
    wrangler = await restartWranglerForTest(wrangler);

    // The recovery transition re-enqueues it as `pending`. A later drain may
    // advance it again, so assert via the recorded status log.
    const log = await pollUntil(
      "submission status log (pending)",
      () => callAgent(agent, "getStatusLog") as Promise<string[]>,
      (entries) => entries.includes(`${submissionId}:pending`)
    );
    expect(log).toContain(`${submissionId}:pending`);
  });

  it("marks an applied-but-unrecoverable submission as error", async () => {
    const agent = "submission-applied-unrecoverable";
    const submissionId = "sub-applied-error";
    const requestId = "req-applied-error";

    wrangler = startWranglerForTest();
    await waitForReady();

    // Seed a `running` submission with messages applied but no recoverable fiber
    // or scheduled continuation for its request id.
    await callAgent(agent, "seedRunningSubmission", [
      submissionId,
      requestId,
      true
    ]);

    wrangler = await restartWranglerForTest(wrangler);

    const view = await pollUntil(
      "submission status (error)",
      () =>
        callAgent(agent, "getSubmission", [
          submissionId
        ]) as Promise<SubmissionView>,
      (v) => v?.status === "error"
    );
    expect(view?.status).toBe("error");
    expect(view?.error ?? "").toContain(
      "interrupted after messages were applied"
    );

    const log = (await callAgent(agent, "getStatusLog")) as string[];
    expect(log).toContain(`${submissionId}:error`);
  });

  it("leaves a recoverable in-flight submission running and continues it to completion", async () => {
    const agent = "submission-recoverable";
    const submissionId = "sub-recoverable";

    wrangler = startWranglerForTest();
    await waitForReady();

    await callAgent(agent, "startSubmission", [
      submissionId,
      "Tell me a long submission story"
    ]);

    // Wait until the submission is running, messages are applied, and the chat
    // recovery fiber row exists (the turn is mid-stream and recoverable).
    await pollUntil(
      "submission running with fiber",
      async () => {
        const view = (await callAgent(agent, "getSubmission", [
          submissionId
        ])) as SubmissionView;
        const messageCount = (await callAgent(
          agent,
          "getMessageCount"
        )) as number;
        const hasFibers = (await callAgent(agent, "hasFiberRows")) as boolean;
        return {
          status: view?.status ?? null,
          messageCount,
          hasFibers
        };
      },
      (s) => s.status === "running" && s.messageCount > 0 && s.hasFibers,
      { attempts: 30, delayMs: 500 }
    );

    // Kill mid-stream and restart with the same persist dir.
    wrangler = await restartWranglerForTest(wrangler);

    // Recovery leaves the submission running; the scheduled continuation re-runs
    // the turn and drives the submission to `completed`.
    const view = await pollUntil(
      "submission status (completed)",
      () =>
        callAgent(agent, "getSubmission", [
          submissionId
        ]) as Promise<SubmissionView>,
      (v) => v?.status === "completed" || v?.status === "error",
      { attempts: 60, delayMs: 1000 }
    );
    expect(view?.status).toBe("completed");

    const log = (await callAgent(agent, "getStatusLog")) as string[];
    expect(log).toContain(`${submissionId}:completed`);
  });
});
