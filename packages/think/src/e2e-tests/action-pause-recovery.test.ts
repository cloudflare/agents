/**
 * E2E test: durable-pause action approval survives a deploy and resumes with no
 * live connection (actions RFC Step 5).
 *
 * Drives the full path inside a real `wrangler dev` runtime:
 *  1. a chat turn calls a `kind: "durable-pause"` action, which parks a row in
 *     `cf_think_action_pending_approvals` and ends the turn
 *  2. a real SIGKILL + restart proves the pending row + its approval descriptor
 *     survive the deploy (rebuilt from the durable store on cold start)
 *  3. `approveExecution` with NO open socket runs the action exactly once and
 *     the connection-independent continuation drives the model to completion
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
const PORT = 18814;
const AGENT_URL = `http://localhost:${PORT}`;
const AGENT_SLUG = "think-action-pause-recovery-e2-e-agent";
const PERSIST_DIR = path.join(
  __dirname,
  ".wrangler-think-action-pause-e2e-state"
);

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

describe("Think durable-pause action recovery e2e", () => {
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

  it("parks across a deploy and resumes on approve with no open connection", async () => {
    const agent = "action-pause-deploy";

    wrangler = startWrangler();
    await waitForReady();

    // 1. A chat turn calls the durable-pause action, which parks and ends.
    const turn = (await callAgent(agent, "startActionPauseTurn", [
      "please deploy"
    ])) as { done: boolean };
    expect(turn.done).toBe(true);

    // The pending row exists and the action has NOT executed yet.
    const pendingBefore = (await callAgent(agent, "pendingCount")) as number;
    expect(pendingBefore).toBe(1);
    expect((await callAgent(agent, "getExecCount")) as number).toBe(0);

    // The approval descriptor is present before the restart.
    const descriptorJson = (await callAgent(agent, "firstPendingJson")) as
      | string
      | null;
    expect(descriptorJson).toBeTruthy();
    const parsed = JSON.parse(descriptorJson as string) as {
      executionId: string;
      source: string;
      descriptor: Record<string, unknown>;
    };
    expect(parsed.source).toBe("action");
    expect(parsed.executionId.startsWith("actpause_")).toBe(true);
    expect(parsed.descriptor).toMatchObject({
      action: "pauseAction",
      kind: "durable-pause",
      summary: "Deploy the thing",
      risk: "high",
      permissions: ["deploy:run"]
    });

    // 2. Real deploy churn: SIGKILL + restart with the same persist dir.
    wrangler = await restartWrangler(wrangler);

    // The pending row + descriptor survived the deploy (rebuilt from the store).
    const survived = (await callAgent(agent, "firstPendingJson")) as
      | string
      | null;
    expect(survived).toBeTruthy();
    const survivedParsed = JSON.parse(survived as string) as {
      executionId: string;
    };
    expect(survivedParsed.executionId).toBe(parsed.executionId);
    expect((await callAgent(agent, "getExecCount")) as number).toBe(0);

    // 3. Approve with NO open connection → runs the action once and the
    //    connection-independent continuation drives the model to completion.
    const approved = (await callAgent(agent, "approveFirstPending")) as {
      executionId: string | null;
      result: string;
    };
    expect(approved.executionId).toBe(parsed.executionId);
    expect(approved.result).toContain("deployed: deploy me");

    // The action executed exactly once and the pending row is cleared.
    expect((await callAgent(agent, "getExecCount")) as number).toBe(1);

    const finalText = await pollUntil(
      "final assistant text",
      () => callAgent(agent, "getFinalText") as Promise<string>,
      (text) => text.includes("approved and acknowledged"),
      { attempts: 30, delayMs: 1000 }
    );
    expect(finalText).toContain("approved and acknowledged");

    const pendingAfter = (await callAgent(agent, "pendingCount")) as number;
    expect(pendingAfter).toBe(0);
  });
});
