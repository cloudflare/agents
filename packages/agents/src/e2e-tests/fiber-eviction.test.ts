/**
 * E2E tests: fiber recovery after real process eviction.
 *
 * These tests start wrangler dev, spawn fibers, kill the process
 * (SIGKILL — mimicking real DO eviction), restart wrangler, and
 * verify fibers recover from their last checkpoint.
 *
 * Since workerd persists alarm state to disk (cloudflare/workerd#6104),
 * alarms set before the kill survive the restart and fire automatically.
 * Recovery is fully automatic — no manual triggerAlarm() needed.
 *
 * The test worker uses keepAliveIntervalMs: 2_000 so the alarm fires
 * within ~2s of restart instead of the default 30s.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18799;
const AGENT_URL = `http://localhost:${PORT}`;
const PERSIST_DIR = path.join(__dirname, ".wrangler-e2e-state");

// ── Helpers ───────────────────────────────────────────────────────────

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
      const pids = output.split("\n").filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGKILL");
          console.log(`[setup] Killed stale process ${pid} on port ${port}`);
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // lsof not available or other error
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
      PERSIST_DIR
    ],
    {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
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

async function waitForReady(maxAttempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${AGENT_URL}/`);
      if (res.status > 0) return;
    } catch {
      // Not ready yet
    }
    await sleep(delayMs);
  }
  throw new Error(`Wrangler did not start within ${maxAttempts * delayMs}ms`);
}

async function waitForPortFree(maxAttempts = 30, delayMs = 500): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fetch(`${AGENT_URL}/`);
    } catch {
      return;
    }
    await sleep(delayMs);
  }
  throw new Error(
    `Port ${PORT} did not free within ${maxAttempts * delayMs}ms`
  );
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
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

const RUN_FIBER_AGENT_NAME = "run-fiber-e2e";

async function callAgentByPath(
  path: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `${AGENT_URL}${path}`;

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

async function callRunFiberAgent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return callAgentByPath(
    `/agents/run-fiber-test-agent/${RUN_FIBER_AGENT_NAME}`,
    method,
    args
  );
}

const SUB_AGENT_FIBER_PARENT_NAME = "sub-agent-fiber-e2e";
const SUB_AGENT_FIBER_CHILD_NAME = "child-fiber-e2e";

async function callSubAgentFiberParent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return callAgentByPath(
    `/agents/sub-agent-fiber-parent/${SUB_AGENT_FIBER_PARENT_NAME}`,
    method,
    args
  );
}

describe("runFiber eviction e2e (no mixin)", () => {
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

  async function startAndWait(): Promise<ChildProcess> {
    const proc = startWrangler();
    await waitForReady();
    return proc;
  }

  async function killAndRestart(): Promise<ChildProcess> {
    console.log("[test] Killing wrangler (SIGKILL)...");
    if (wrangler) await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree();
    console.log("[test] Restarting wrangler...");
    const proc = startWrangler();
    await waitForReady();
    console.log("[test] Wrangler restarted");
    return proc;
  }

  it("should recover a runFiber after process kill via persisted alarm", async () => {
    wrangler = await startAndWait();

    // Start a slow fiber (10 steps, 1s each)
    await callRunFiberAgent("startSlowFiber", [8]);

    // Wait for a few steps
    await sleep(3500);

    // Check that a fiber is running with checkpoint data
    const statusBefore = (await callRunFiberAgent(
      "getRunningFiberSnapshot"
    )) as {
      completedSteps: Array<{ index: number }>;
      totalSteps: number;
    } | null;
    expect(statusBefore).not.toBeNull();
    expect(statusBefore!.completedSteps.length).toBeGreaterThan(0);
    expect(statusBefore!.completedSteps.length).toBeLessThan(8);

    // Kill the server
    wrangler = await killAndRestart();

    // Wait for the alarm to fire and recovery to complete
    // With keepAliveIntervalMs: 2s, alarm fires within ~2s
    let recovered = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const status = (await callRunFiberAgent("getFiberStatus")) as {
          hasRunningFibers: boolean;
          recoveredCount: number;
        };
        console.log(
          `[test] Poll ${i + 1}: running=${status.hasRunningFibers}, recovered=${status.recoveredCount}`
        );
        if (status.recoveredCount > 0 && !status.hasRunningFibers) {
          recovered = true;
          break;
        }
      } catch (_e) {
        console.log(`[test] Poll ${i + 1}: error (agent may not be ready)`);
      }
    }

    expect(recovered).toBe(true);

    // Verify the recovery hook was called with the snapshot
    const recoveredFibers = (await callRunFiberAgent(
      "getRecoveredFibers"
    )) as Array<{
      id: string;
      name: string;
      snapshot: unknown;
    }>;
    expect(recoveredFibers.length).toBeGreaterThanOrEqual(1);
    expect(recoveredFibers[0].name).toBe("slowSteps");
    expect(recoveredFibers[0].snapshot).not.toBeNull();
  });

  it("should recover a sub-agent runFiber after process kill via the parent alarm", async () => {
    wrangler = await startAndWait();

    await callSubAgentFiberParent("startChildSlowFiber", [
      SUB_AGENT_FIBER_CHILD_NAME,
      8
    ]);

    await sleep(3500);

    const statusBefore = (await callSubAgentFiberParent(
      "getChildRunningFiberSnapshot",
      [SUB_AGENT_FIBER_CHILD_NAME]
    )) as {
      completedSteps: Array<{ index: number }>;
      totalSteps: number;
    } | null;
    expect(statusBefore).not.toBeNull();
    expect(statusBefore!.completedSteps.length).toBeGreaterThan(0);
    expect(statusBefore!.completedSteps.length).toBeLessThan(8);

    wrangler = await killAndRestart();

    let recovered = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const status = (await callSubAgentFiberParent("getChildFiberStatus", [
          SUB_AGENT_FIBER_CHILD_NAME
        ])) as {
          hasRunningFibers: boolean;
          recoveredCount: number;
        };
        console.log(
          `[test] Sub-agent poll ${i + 1}: running=${status.hasRunningFibers}, recovered=${status.recoveredCount}`
        );
        if (status.recoveredCount > 0 && !status.hasRunningFibers) {
          recovered = true;
          break;
        }
      } catch {
        console.log(
          `[test] Sub-agent poll ${i + 1}: error (agent may not be ready)`
        );
      }
    }

    expect(recovered).toBe(true);

    const recoveredFibers = (await callSubAgentFiberParent(
      "getChildRecoveredFibers",
      [SUB_AGENT_FIBER_CHILD_NAME]
    )) as Array<{
      id: string;
      name: string;
      snapshot: unknown;
    }>;
    expect(recoveredFibers.length).toBeGreaterThanOrEqual(1);
    expect(recoveredFibers[0].name).toBe("subSlowSteps");
    expect(recoveredFibers[0].snapshot).not.toBeNull();
  });
});
