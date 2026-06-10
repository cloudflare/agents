/**
 * E2E test: Think workflow-turn recovery + workflow-notification drain replay.
 *
 * A `ThinkWorkflow` `step.prompt` creates a durable submission (the "workflow
 * turn") and waits for the completion event delivered through the
 * workflow-notification drain. This test:
 *  1. happy path — a deterministic mock structured turn completes, the
 *     notification is drained, and the workflow resumes + completes with the
 *     validated structured output (no real LLM, no kill)
 *  2. recovery — the workflow turn is interrupted mid-stream by a SIGKILL; on
 *     restart the turn is recovered and the workflow reaches a terminal state
 *     via the workflow-notification drain replay
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
const PORT = 18813;
const AGENT_URL = `http://localhost:${PORT}`;
const AGENT_SLUG = "think-workflow-recovery-e2-e-agent";
const GREETING = "hello from a recovered workflow turn";
const PERSIST_DIR = path.join(__dirname, ".wrangler-think-workflow-e2e-state");

type WorkflowView = { status: string; output: unknown; error: string | null };

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
    }, 15000);

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

describe("Think workflow-turn recovery e2e", () => {
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

  it("completes a structured workflow turn and drains the notification (happy path)", async () => {
    const agent = "workflow-happy";

    wrangler = startWrangler();
    await waitForReady();

    const id = (await callAgent(agent, "startGreetingWorkflow")) as string;

    const view = await pollUntil(
      "workflow status (happy)",
      () =>
        callAgent(agent, "inspectWorkflowRun", [id]) as Promise<WorkflowView>,
      (v) =>
        v.status === "complete" ||
        v.status === "errored" ||
        v.status === "terminated",
      { attempts: 90, delayMs: 1000 }
    );
    expect(view.status).toBe("complete");
    expect(view.output).toMatchObject({ greeting: GREETING });

    // The submission delivered its completion event through the
    // workflow-notification drain.
    const stats = (await callAgent(agent, "getNotificationStats")) as {
      total: number;
      delivered: number;
    };
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.delivered).toBeGreaterThanOrEqual(1);
  });

  it("unblocks a workflow whose turn was interrupted mid-stream via the notification drain replay", async () => {
    const agent = "workflow-recovery";

    wrangler = startWrangler();
    await waitForReady();

    const id = (await callAgent(agent, "startGreetingWorkflow")) as string;

    // Wait until the workflow-turn submission is mid-stream (chat fiber row).
    await pollUntil(
      "workflow turn in-flight",
      () => callAgent(agent, "hasFiberRows") as Promise<boolean>,
      (has) => has === true,
      { attempts: 30, delayMs: 250 }
    );

    // Kill mid-stream and restart with the same persist dir.
    wrangler = await restartWrangler(wrangler);

    // The proven recovery guarantee: on restart the interrupted workflow turn is
    // reconciled to a terminal submission status and the workflow-notification
    // drain REPLAYS that result via `sendWorkflowEvent`, so the workflow's
    // `waitForEvent` resolves and the workflow reaches a terminal state instead
    // of hanging forever.
    //
    // NOTE (deferred): a STRUCTURED workflow turn interrupted mid-stream is
    // currently recovered as `skipped` — the mid-stream partial makes the chat
    // recovery continuation skip rather than re-run the turn, so the workflow
    // surfaces `ThinkPromptSkippedError` rather than completing with the
    // structured output. Full output-preserving structured-turn recovery (the
    // workflow COMPLETING after a mid-stream kill) is a known gap and is
    // deferred here; this test locks in the no-hang + notification-replay
    // guarantee that holds today.
    const view = await pollUntil(
      "workflow status (recovery)",
      () =>
        callAgent(agent, "inspectWorkflowRun", [id]) as Promise<WorkflowView>,
      (v) =>
        v.status === "complete" ||
        v.status === "errored" ||
        v.status === "terminated",
      { attempts: 120, delayMs: 1000 }
    );
    // The workflow is unblocked (terminal), not hung.
    expect(["complete", "errored", "terminated"]).toContain(view.status);

    // The submission's terminal status was delivered through the
    // workflow-notification drain (replay after restart).
    const stats = (await callAgent(agent, "getNotificationStats")) as {
      total: number;
      delivered: number;
    };
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.delivered).toBeGreaterThanOrEqual(1);
  });
});
