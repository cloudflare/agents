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
import { spawn, type ChildProcess } from "node:child_process";
import { killProcess, killProcessOnPort } from "./wrangler-process";
import { setDefaultAutoSelectFamily } from "node:net";
import "./harden-net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

setDefaultAutoSelectFamily(false);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18811;
const AGENT_URL = `http://localhost:${PORT}`;
const AGENT_SLUG = "think-submission-recovery-e2-e-agent";
const PERSIST_DIR = path.join(
  __dirname,
  ".wrangler-think-submission-e2e-state"
);

type SubmissionView = { status: string; error: string | null } | null;
type RecoveryOutcome = {
  userMessages: number;
  assistantMessages: number;
  responseCount: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startWrangler(): ChildProcess {
  const configPath = path.join(__dirname, "wrangler.jsonc");
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      configPath,
      "--port",
      String(PORT),
      "--persist-to",
      PERSIST_DIR,
      "--inspector-port",
      "0"
    ],
    {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
      // A process-group leader, so killProcess() can take down wrangler and
      // every workerd it spawns in one signal.
      detached: true,
      env: { ...process.env, NODE_ENV: "test" }
    }
  );

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler] ${line}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler:err] ${line}`);
  });

  return child;
}

async function waitForReady(maxAttempts = 60, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${AGENT_URL}/`);
      await res.body?.cancel();
      if (res.status > 0) return;
    } catch {
      // Not ready
    }
    await sleep(delayMs);
  }
  throw new Error("Wrangler did not start in time");
}

async function waitForPortFree(maxAttempts = 30, delayMs = 500): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${AGENT_URL}/`);
      await res.body?.cancel();
    } catch {
      return;
    }
    await sleep(delayMs);
  }
  throw new Error(`Port ${PORT} did not free in time`);
}

async function restartWrangler(child: ChildProcess): Promise<ChildProcess> {
  await killProcess(child);
  await waitForPortFree();
  const next = startWrangler();
  await waitForReady();
  return next;
}

async function callAgent(
  agentName: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `${AGENT_URL}/agents/${AGENT_SLUG}/${agentName}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC call ${method} timed out`));
    }, 10000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "rpc" && msg.id === id) {
          clearTimeout(timeout);
          ws.close();
          if (msg.success) {
            resolve(msg.result);
          } else {
            reject(new Error(msg.error || "RPC failed"));
          }
        }
      } catch {
        // Ignore non-RPC messages
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

async function pollUntil<T>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options?: { attempts?: number; delayMs?: number }
): Promise<T> {
  const attempts = options?.attempts ?? 30;
  const delayMs = options?.delayMs ?? 1000;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    try {
      const value = await read();
      console.log(`[test] ${label} poll ${i + 1}:`, value);
      if (done(value)) return value;
    } catch (error) {
      lastError = error;
      console.log(`[test] ${label} poll ${i + 1}: error`);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${label}`);
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

    wrangler = startWrangler();
    await waitForReady();

    // Seed a `running` submission with messages_applied_at NULL and a message id
    // absent from history (the messages-not-applied path).
    await callAgent(agent, "seedRunningSubmission", [
      submissionId,
      requestId,
      false
    ]);

    // Restart: `_recoverSubmissionsOnStart` re-runs on the next DO start.
    wrangler = await restartWrangler(wrangler);

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

    wrangler = startWrangler();
    await waitForReady();

    // Seed a `running` submission with messages applied but no recoverable fiber
    // or scheduled continuation for its request id.
    await callAgent(agent, "seedRunningSubmission", [
      submissionId,
      requestId,
      true
    ]);

    wrangler = await restartWrangler(wrangler);

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

  it("preserves a production-scheduled empty-stream retry across a second restart", async () => {
    const agent = "submission-pending-retry";
    const submissionId = "sub-pending-retry";

    wrangler = startWrangler();
    await waitForReady();
    await callAgent(agent, "seedRecoverableEmptySubmission", [submissionId]);

    // Restart #1 runs real interrupted-chat classification. The empty opened
    // stream becomes a retry carrying production-owned incident/submission data.
    wrangler = await restartWrangler(wrangler);
    await pollUntil(
      "production-scheduled retry backoff",
      () =>
        callAgent(agent, "hasWaitingRecoveryRetry", [
          submissionId
        ]) as Promise<boolean>,
      (waiting) => waiting,
      { attempts: 30, delayMs: 100 }
    );
    await expect(
      callAgent(agent, "getSubmission", [submissionId])
    ).resolves.toMatchObject({ status: "running" });

    // Restart #2 lands after the first recovery Task has settled and while its
    // real delayed successor owns the still-running submission.
    wrangler = await restartWrangler(wrangler);
    const view = await pollUntil(
      "empty-stream retry completion",
      () =>
        callAgent(agent, "getSubmission", [
          submissionId
        ]) as Promise<SubmissionView>,
      (submission) =>
        submission?.status === "completed" || submission?.status === "error",
      { attempts: 60, delayMs: 500 }
    );
    expect(view?.status).toBe("completed");

    const outcome = (await callAgent(
      agent,
      "getRecoveryOutcome"
    )) as RecoveryOutcome;
    expect(outcome).toEqual({
      userMessages: 1,
      assistantMessages: 1,
      responseCount: 1
    });

    const log = (await callAgent(agent, "getStatusLog")) as string[];
    expect(
      log.filter((entry) => entry === `${submissionId}:completed`)
    ).toHaveLength(1);
  });

  it("preserves completed successor evidence through foreign reclaim and a crash before ledger settlement", async () => {
    const agent = "submission-terminal-reclaim";
    const submissionId = "sub-terminal-reclaim";
    wrangler = startWrangler();
    await waitForReady();
    await callAgent(agent, "startRecoveryAtLedgerGap", [submissionId]);
    await pollUntil(
      "successor completed before ledger settlement",
      () => callAgent(agent, "isRecoveryAtLedgerGap") as Promise<boolean>,
      (paused) => paused,
      { attempts: 60, delayMs: 500 }
    );
    await expect(
      callAgent(agent, "getSubmission", [submissionId])
    ).resolves.toMatchObject({ status: "running" });
    // The cutover discarded the stream rows and stamped the durable outcome;
    // a foreign producer's reclaim cannot erase that fact.
    await expect(
      callAgent(agent, "reclaimDuringSubmissionGap", [submissionId])
    ).resolves.toEqual({
      streamStatus: null,
      resultStatus: "completed"
    });

    wrangler = await restartWrangler(wrangler);
    const settled = await pollUntil(
      "startup terminal-stream settlement",
      () =>
        callAgent(agent, "getSubmission", [
          submissionId
        ]) as Promise<SubmissionView>,
      (submission) => submission?.status !== "running"
    );
    expect(settled).toEqual({ status: "completed", error: null });
    await expect(callAgent(agent, "getRecoveryOutcome")).resolves.toEqual({
      userMessages: 1,
      assistantMessages: 1,
      responseCount: 1
    });
    await expect(callAgent(agent, "getStatusLog")).resolves.toEqual([
      `${submissionId}:completed`
    ]);
    // Startup settled the ledger and cleared the stamp. Nothing leaks forever.
    await expect(
      callAgent(agent, "reclaimDuringSubmissionGap", [submissionId])
    ).resolves.toEqual({
      streamStatus: null,
      resultStatus: null
    });
  });

  it.each([
    { mode: "abort", facet: false },
    { mode: "output", facet: false },
    { mode: "abort", facet: true },
    { mode: "output", facet: true }
  ] as const)(
    "recovers the recorded $mode outcome after cutover (facet: $facet)",
    async ({ mode, facet }) => {
      const agent = `submission-cutover-${mode}-${facet}`;
      const submissionId = `sub-cutover-${mode}`;
      type CutoverView = {
        paused: boolean;
        status: string | null;
        events: unknown[];
        assistantMessages: number;
      };
      const inspect = () =>
        callAgent(agent, "inspectSubmissionCutover", [
          submissionId,
          facet
        ]) as Promise<CutoverView>;
      wrangler = startWrangler();
      await waitForReady();
      await callAgent(agent, "startSubmissionAtCutover", [
        submissionId,
        mode,
        facet
      ]);
      const before = await pollUntil(
        "turn cutover before ledger settlement",
        inspect,
        (view) => view.paused,
        { delayMs: 100 }
      );
      expect(before.status).toBe("running");
      expect(before.events).toEqual([]);
      expect(before.assistantMessages).toBe(mode === "abort" ? 1 : 0);

      wrangler = await restartWrangler(wrangler);
      const after = await pollUntil(
        "recorded outcome delivered after restart",
        inspect,
        (view) => view.events.length > 0,
        { delayMs: 200 }
      );
      expect(after.status).toBe(mode === "abort" ? "aborted" : "completed");
      expect(after.events).toEqual([
        mode === "abort"
          ? { submissionId, status: "aborted" }
          : {
              submissionId,
              status: "completed",
              output: { greeting: "hello from a recovered workflow turn" }
            }
      ]);
      expect(after.assistantMessages).toBe(before.assistantMessages);
    }
  );

  it("leaves a recoverable in-flight submission running and continues it to completion", async () => {
    const agent = "submission-recoverable";
    const submissionId = "sub-recoverable";

    wrangler = startWrangler();
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
    wrangler = await restartWrangler(wrangler);

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
