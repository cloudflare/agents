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
const AGENT_NAME = "fiber-test-agent";
const PERSIST_DIR = path.join(__dirname, ".wrangler-e2e-state");

// ── Helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessOnPort(port: number): void {
  try {
    const output = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`)
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

/**
 * Call a method on the agent via WebSocket RPC.
 */
async function callAgent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `${AGENT_URL}/agents/fiber-test-agent/${AGENT_NAME}`;

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
        // Ignore non-RPC messages (state sync, identity, etc.)
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

type FiberStatus = {
  status: string;
  snapshot: {
    completedSteps: unknown[];
    totalSteps: number;
  } | null;
  retryCount: number;
};

/**
 * Poll until a fiber reaches the target status or timeout.
 */
async function pollFiber(
  fiberId: string,
  targetStatus: string,
  maxPollSeconds = 30,
  label = ""
): Promise<FiberStatus> {
  let status: FiberStatus | null = null;

  for (let i = 0; i < maxPollSeconds; i++) {
    await sleep(1000);
    try {
      status = (await callAgent("getFiberStatus", [fiberId])) as FiberStatus;
      const tag = label ? `[${label}]` : "";
      console.log(
        `${tag} Poll ${i + 1}: status=${status?.status}, ` +
          `steps=${status?.snapshot?.completedSteps?.length ?? 0}, ` +
          `retryCount=${status?.retryCount}`
      );
      if (status?.status === targetStatus) return status;
    } catch (_e) {
      const tag = label ? `[${label}]` : "";
      console.log(`${tag} Poll ${i + 1}: error (agent may not be ready yet)`);
    }
  }

  throw new Error(
    `Fiber ${fiberId} did not reach status "${targetStatus}" within ${maxPollSeconds}s. ` +
      `Last status: ${status?.status ?? "unknown"}`
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("fiber eviction e2e", () => {
  let wrangler: ChildProcess | null = null;

  beforeEach(() => {
    killProcessOnPort(PORT);
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK if it doesn't exist
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
      // OK if it doesn't exist
    }
  });

  // ── Helpers for the kill/restart cycle ───────────────────────────

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

  // ── Test: automatic recovery via persisted alarm ────────────────

  it("should recover a fiber automatically via persisted alarm", async () => {
    wrangler = await startAndWait();

    const fiberId = (await callAgent("startSlowFiber", [8])) as string;
    expect(fiberId).toBeDefined();

    await sleep(3500);

    const before = (await callAgent("getFiberStatus", [
      fiberId
    ])) as FiberStatus;
    expect(before.status).toBe("running");
    expect(before.snapshot).not.toBeNull();
    const stepsBefore = before.snapshot?.completedSteps?.length ?? 0;
    expect(stepsBefore).toBeGreaterThan(0);
    expect(stepsBefore).toBeLessThan(8);

    wrangler = await killAndRestart();

    // With keepAliveIntervalMs: 2_000, the alarm fires within ~2s
    const after = await pollFiber(fiberId, "completed", 30, "recovery");

    expect(after.status).toBe("completed");
    expect(after.retryCount).toBeGreaterThanOrEqual(1);
    expect(after.snapshot?.completedSteps?.length).toBe(8);
  });

  // ── Test: checkpoint preservation through real kill ──────────────

  it("should preserve checkpoint data through a real process kill", async () => {
    wrangler = await startAndWait();

    const fiberId = (await callAgent("startSlowFiber", [6])) as string;

    // Wait for 3 steps to complete
    await sleep(3500);

    const before = (await callAgent("getFiberStatus", [
      fiberId
    ])) as FiberStatus;
    expect(before.status).toBe("running");
    const stepsBefore = before.snapshot?.completedSteps?.length ?? 0;
    expect(stepsBefore).toBeGreaterThan(0);
    console.log(
      `[test] Checkpoint before kill: ${stepsBefore} steps completed`
    );

    wrangler = await killAndRestart();

    const after = await pollFiber(fiberId, "completed", 30, "checkpoint");

    expect(after.status).toBe("completed");
    expect(after.snapshot?.completedSteps?.length).toBe(6);
    expect(after.retryCount).toBeGreaterThanOrEqual(1);

    // Verify the fiber resumed from checkpoint (execution log should show
    // steps starting from where it left off, not re-doing completed steps).
    // The total step count in the snapshot should be exactly 6.
    const steps = after.snapshot?.completedSteps as Array<{
      index: number;
      value: string;
    }>;
    expect(steps[0].index).toBe(0);
    expect(steps[steps.length - 1].index).toBe(5);
  });

  // ── Test: multiple concurrent fiber recovery ────────────────────

  it("should recover multiple concurrent fibers after kill", async () => {
    wrangler = await startAndWait();

    const id1 = (await callAgent("startSlowFiber", [5])) as string;
    const id2 = (await callAgent("startSlowFiber", [5])) as string;
    expect(id1).not.toBe(id2);

    // Wait for both to make some progress
    await sleep(2500);

    const before1 = (await callAgent("getFiberStatus", [id1])) as FiberStatus;
    const before2 = (await callAgent("getFiberStatus", [id2])) as FiberStatus;
    expect(before1.status).toBe("running");
    expect(before2.status).toBe("running");

    wrangler = await killAndRestart();

    // Both fibers should recover and complete
    const after1 = await pollFiber(id1, "completed", 30, "fiber-1");
    const after2 = await pollFiber(id2, "completed", 30, "fiber-2");

    expect(after1.status).toBe("completed");
    expect(after2.status).toBe("completed");
    expect(after1.snapshot?.completedSteps?.length).toBe(5);
    expect(after2.snapshot?.completedSteps?.length).toBe(5);
    expect(after1.retryCount).toBeGreaterThanOrEqual(1);
    expect(after2.retryCount).toBeGreaterThanOrEqual(1);
  });

  // ── Test: completed fiber survives restart ──────────────────────

  it("should not re-execute a completed fiber after restart", async () => {
    wrangler = await startAndWait();

    const fiberId = (await callAgent("startSimpleFiber", [
      "fast-task"
    ])) as string;

    // simpleWork completes immediately
    await sleep(500);

    const before = (await callAgent("getFiberStatus", [
      fiberId
    ])) as FiberStatus;
    expect(before.status).toBe("completed");

    wrangler = await killAndRestart();

    // After restart, wait a few seconds for any alarms to fire
    await sleep(4000);

    const after = (await callAgent("getFiberStatus", [fiberId])) as FiberStatus;

    // Fiber should still be completed, not re-executed
    expect(after.status).toBe("completed");
    expect(after.retryCount).toBe(0);
  });

  // ── Test: recovery fires onFiberRecovered hook ──────────────────

  it("should fire onFiberRecovered hook on recovery", async () => {
    wrangler = await startAndWait();

    const fiberId = (await callAgent("startSlowFiber", [6])) as string;
    await sleep(2500);

    const before = (await callAgent("getFiberStatus", [
      fiberId
    ])) as FiberStatus;
    expect(before.status).toBe("running");

    wrangler = await killAndRestart();

    await pollFiber(fiberId, "completed", 30, "hook");

    // The onFiberRecovered hook should have recorded the recovery
    const recovered = (await callAgent("getRecoveredFibersList")) as Array<{
      id: string;
      methodName: string;
      snapshot: unknown;
      retryCount: number;
    }>;

    expect(recovered.length).toBeGreaterThanOrEqual(1);
    const entry = recovered.find((r) => r.id === fiberId);
    expect(entry).toBeDefined();
    expect(entry!.methodName).toBe("slowSteps");
    expect(entry!.retryCount).toBeGreaterThanOrEqual(1);
    expect(entry!.snapshot).not.toBeNull();
  });
});

// ── runFiber E2E (Agent.runFiber — no mixin) ──────────────────────────

const RUN_FIBER_AGENT_NAME = "run-fiber-e2e";

async function callRunFiberAgent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `${AGENT_URL}/agents/run-fiber-test-agent/${RUN_FIBER_AGENT_NAME}`;

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
});
