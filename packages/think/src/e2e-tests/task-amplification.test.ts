/**
 * E2E: does an eviction mid-`task` re-run the ENTIRE child turn? ("amplification")
 *
 * A parent turn calls one `runTask` tool that drives a child agent
 * (`ThinkToolRollbackE2EAgent`) through a 30-step ledger loop via
 * `runAgentTool` (stable runId → idempotent by design). We SIGKILL+restart
 * while the child is mid-work, then check the CHILD ledger:
 *
 *   childReRuns = child.totalExecutions - child.uniqueIndices
 *
 * If childReRuns stays bounded (~ child evictions), idempotency + per-agent
 * recovery hold and one in-flight `task` step does NOT re-run completed child
 * work. If child.totalExecutions blows up (≈ 30 × parentTaskExecutions), the
 * parent re-running the in-flight task amplifies into a full child re-run.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { setDefaultAutoSelectFamily } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

setDefaultAutoSelectFamily(false);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18795;
const AGENT_URL = `http://127.0.0.1:${PORT}`;
const AGENT_SLUG = "think-task-parent-e2-e-agent";
const AGENT_NAME = "task-parent-e2e";
const PERSIST_DIR = path.join(__dirname, ".wrangler-task-amp-state");
const CHILD_STEPS = 30;

type TaskStatus = {
  parentTaskExecutions: number;
  parentRecoveries: number;
  parentHasFiberRows: boolean;
  child: {
    totalExecutions: number;
    uniqueIndices: number;
    maxIndex: number;
    duplicates: Array<{ index: number; count: number }>;
    recoveryCount: number;
    hasFiberRows: boolean;
  } | null;
};

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
          // already dead
        }
      }
    }
  } catch {
    // lsof unavailable
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
    // pgrep unavailable
  }
  for (const child of children) killProcessTree(child);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already dead
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
  child.stdout?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[wrangler] ${line}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
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
      // not ready
    }
    await sleep(delayMs);
  }
  throw new Error("Wrangler did not start in time");
}

async function waitForPortFree(maxAttempts = 60, delayMs = 500): Promise<void> {
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

function sendChatMessage(text: string): Promise<void> {
  const url = `${AGENT_URL}/agents/${AGENT_SLUG}/${AGENT_NAME}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      resolve();
    }, 4000);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: crypto.randomUUID(),
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: `user-${Date.now()}`,
                  role: "user",
                  parts: [{ type: "text", text }]
                }
              ]
            })
          }
        })
      );
      setTimeout(() => {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }, 2500);
    };
    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

async function callAgent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `${AGENT_URL}/agents/${AGENT_SLUG}/${AGENT_NAME}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC ${method} timed out`));
    }, 10000);
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "rpc" && msg.id === id) {
          clearTimeout(timeout);
          ws.close();
          if (msg.success) resolve(msg.result);
          else reject(new Error(msg.error || "RPC failed"));
        }
      } catch {
        // ignore
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`RPC ${method} socket error`));
    };
  });
}

async function readStatus(): Promise<TaskStatus | null> {
  try {
    return (await callAgent("getTaskStatus")) as TaskStatus;
  } catch {
    return null;
  }
}

describe("task amplification under rapid churn", () => {
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

  it("does not re-run the whole child turn when the parent task step is evicted", async () => {
    wrangler = startWrangler();
    await waitForReady();

    await sendChatMessage("seed the database");

    for (let i = 0; i < 3; i++) {
      await sleep(3000);
      console.log(`[task-amp] churn cycle ${i + 1}`);
      wrangler = await restartWrangler(wrangler);
    }

    let status: TaskStatus | null = null;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(3000);
      status = await readStatus();
      if (status) {
        console.log(
          `[task-amp] poll: parentRuns=${status.parentTaskExecutions} parentRecov=${status.parentRecoveries} parentFibers=${status.parentHasFiberRows} child=${JSON.stringify(status.child)}`
        );
        if (
          status.child &&
          status.child.maxIndex >= CHILD_STEPS &&
          !status.child.hasFiberRows &&
          !status.parentHasFiberRows
        ) {
          break;
        }
      }
    }

    expect(status).not.toBeNull();
    const s = status as TaskStatus;
    const child = s.child;
    const childReRuns = child
      ? child.totalExecutions - child.uniqueIndices
      : -1;
    const summary = {
      at: new Date().toISOString(),
      parentTaskExecutions: s.parentTaskExecutions,
      parentRecoveries: s.parentRecoveries,
      childUnique: child?.uniqueIndices,
      childTotal: child?.totalExecutions,
      childReRuns,
      childRecoveries: child?.recoveryCount,
      childDuplicates: child?.duplicates,
      verdict:
        !child || child.uniqueIndices < CHILD_STEPS
          ? "INCOMPLETE"
          : childReRuns <=
              s.parentTaskExecutions + (child.recoveryCount ?? 0) + 1
            ? "BOUNDED"
            : "AMPLIFIED"
    };
    console.log(`[task-amp] FINAL: ${JSON.stringify(summary)}`);
    try {
      fs.appendFileSync(
        "/tmp/task-amplification.log",
        `${JSON.stringify(summary)}\n`
      );
    } catch {
      // best-effort
    }

    expect(child).not.toBeNull();
    // Child eventually completes every step.
    expect((child as NonNullable<typeof child>).uniqueIndices).toBe(
      CHILD_STEPS
    );
    // The whole child turn must not re-run: re-runs bounded by evictions, not
    // ~CHILD_STEPS × parentTaskExecutions.
    expect(childReRuns).toBeLessThan(CHILD_STEPS);
  });
});
