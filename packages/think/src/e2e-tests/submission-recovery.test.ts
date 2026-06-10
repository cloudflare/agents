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
import { spawn, execSync, type ChildProcess } from "node:child_process";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessOnPort(port: number): void {
  try {
    const output = execSync(
      `lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`
    )
      .toString()
      .trim();
    if (output) {
      for (const pid of output.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Already dead
        }
      }
    }
  } catch {
    // lsof not available
  }
}

function killProcessTree(pid: number): void {
  let children: number[] = [];
  try {
    children = execSync(`pgrep -P ${pid} 2>/dev/null || true`)
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    // pgrep may be unavailable; killing the parent is still useful.
  }
  for (const childPid of children) {
    killProcessTree(childPid);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already dead
  }
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

function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid) {
      resolve();
      return;
    }
    const fallback = setTimeout(resolve, 3000);
    child.on("exit", () => {
      clearTimeout(fallback);
      resolve();
    });
    killProcessTree(child.pid);
  });
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
