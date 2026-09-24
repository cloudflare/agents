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
 *     restart the turn is recovered and the workflow completes with the
 *     structured output via the workflow-notification drain replay
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
const PORT = 18813;
const AGENT_URL = `http://localhost:${PORT}`;
const AGENT_SLUG = "think-workflow-recovery-e2-e-agent";
const GREETING = "hello from a recovered workflow turn";
const PERSIST_DIR = path.join(__dirname, ".wrangler-think-workflow-e2e-state");

type WorkflowView = { status: string; output: unknown; error: string | null };

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

  it("completes a workflow whose structured turn was interrupted mid-stream (#1727)", async () => {
    const agent = "workflow-recovery";

    wrangler = startWrangler();
    await waitForReady();

    const id = (await callAgent(agent, "startGreetingWorkflow")) as string;

    type Progress = { streams: number; emitted: number; total: number };
    const progress = () =>
      callAgent(agent, "getFinalAnswerProgress") as Promise<Progress>;

    // Wait until the final-answer tool input is part-way through streaming.
    const beforeKill = await pollUntil(
      "final-answer input mid-stream",
      progress,
      (p) => p.emitted >= 1,
      { attempts: 200, delayMs: 100 }
    );
    expect(beforeKill.emitted).toBeLessThan(beforeKill.total);

    // Kill mid-stream and restart with the same persist dir.
    wrangler = await restartWrangler(wrangler);

    // The kill lands inside the final-answer tool input, so recovery re-runs
    // the turn with the structured-output tool armed, and the drain delivers
    // the recovered output to the workflow.
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
    expect(view.status).toBe("complete");
    expect(view.output).toMatchObject({ greeting: GREETING });
    expect((await progress()).streams).toBeGreaterThanOrEqual(2);

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
