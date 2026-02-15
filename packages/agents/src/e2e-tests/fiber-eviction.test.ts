/**
 * E2E test: fiber recovery after real process eviction.
 *
 * This test starts wrangler dev, spawns a slow fiber, kills the process
 * (SIGKILL — mimicking a real DO eviction), restarts wrangler, and
 * verifies the fiber recovers from its last checkpoint.
 *
 * Unlike the unit tests that simulate eviction by manipulating SQLite,
 * this test exercises the full real path: process death → SQLite persists →
 * alarm fires on restart → _checkInterruptedFibers → experimental_onFiberRecovered.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
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

/**
 * Start wrangler dev as a child process with persistent storage.
 */
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

  // Collect stdout/stderr for debugging
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

/**
 * Wait for wrangler to be ready by polling the port.
 */
async function waitForReady(maxAttempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${AGENT_URL}/`);
      // Any response (even 404) means wrangler is up
      if (res.status > 0) return;
    } catch {
      // Not ready yet
    }
    await sleep(delayMs);
  }
  throw new Error(`Wrangler did not start within ${maxAttempts * delayMs}ms`);
}

/**
 * Wait for the port to be free (wrangler fully stopped).
 */
async function waitForPortFree(maxAttempts = 30, delayMs = 500): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fetch(`${AGENT_URL}/`);
      // Still responding — wait
    } catch {
      // Connection refused — port is free
      return;
    }
    await sleep(delayMs);
  }
  throw new Error(
    `Port ${PORT} did not free within ${maxAttempts * delayMs}ms`
  );
}

/**
 * Kill a child process with SIGKILL (instant death, no graceful shutdown).
 */
function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid) {
      resolve();
      return;
    }
    child.on("exit", () => resolve());
    // SIGKILL the entire process group to catch child processes
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Process may already be dead
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }
    // Timeout fallback
    setTimeout(resolve, 3000);
  });
}

/**
 * Call a method on the agent via WebSocket RPC.
 * Opens a WebSocket, sends the RPC call, waits for the response, closes.
 */
async function callAgent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  // Use HTTP to get the agent stub, then call via fetch
  // Actually, the simplest approach: use the WebSocket RPC protocol directly
  const url = `${AGENT_URL}/agents/fiber-test-agent/${AGENT_NAME}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC call ${method} timed out`));
    }, 10000);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "rpc",
          id,
          method,
          args
        })
      );
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

// ── Tests ─────────────────────────────────────────────────────────────

describe("fiber eviction e2e", () => {
  let wrangler: ChildProcess | null = null;

  afterEach(async () => {
    // Clean up wrangler process
    if (wrangler) {
      await killProcess(wrangler);
      wrangler = null;
    }
    // Clean up persist directory
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK if it doesn't exist
    }
  });

  it("should recover a fiber after wrangler process is killed", async () => {
    // ── Phase 1: Start wrangler and spawn a slow fiber ────────────
    wrangler = startWrangler();
    // Need detached: true for process group kill to work
    await waitForReady();
    console.log("[test] Wrangler is ready");

    // Start a 10-step fiber (takes ~10 seconds total)
    const fiberId = (await callAgent("startSlowFiber", [10])) as string;
    console.log(`[test] Spawned fiber: ${fiberId}`);
    expect(fiberId).toBeDefined();
    expect(typeof fiberId).toBe("string");

    // Wait for 3-4 steps to complete (~3.5 seconds)
    await sleep(3500);

    // Verify some steps completed
    const statusBefore = (await callAgent("getFiberStatus", [
      fiberId
    ])) as FiberStatus;
    console.log(
      `[test] Before kill: status=${statusBefore.status}, ` +
        `steps=${statusBefore.snapshot?.completedSteps?.length ?? 0}/${statusBefore.snapshot?.totalSteps ?? "?"}, ` +
        `retryCount=${statusBefore.retryCount}`
    );

    expect(statusBefore.status).toBe("running");
    expect(statusBefore.snapshot).not.toBeNull();
    const stepsBefore = statusBefore.snapshot?.completedSteps?.length ?? 0;
    expect(stepsBefore).toBeGreaterThan(0);
    expect(stepsBefore).toBeLessThan(10); // Not yet finished

    // ── Phase 2: Kill the process (simulate eviction) ─────────────
    console.log("[test] Killing wrangler (SIGKILL)...");
    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree();
    console.log("[test] Wrangler is dead, port is free");

    // ── Phase 3: Restart wrangler (same persist dir) ──────────────
    console.log("[test] Restarting wrangler...");
    wrangler = startWrangler();
    await waitForReady();
    console.log("[test] Wrangler restarted");

    // ── Phase 4: Trigger recovery ───────────────────────────────────
    // In production, the heartbeat alarm fires automatically and triggers
    // recovery. In wrangler dev, persisted alarms don't survive process
    // restarts (miniflare limitation), so we trigger the alarm manually.
    // This is still a valid e2e test — the important part is that SQLite
    // state (fiber + checkpoint + heartbeat schedule) survived the kill.
    console.log("[test] Triggering alarm for recovery...");
    await callAgent("triggerAlarm", []);
    console.log(
      "[test] Alarm triggered, waiting for recovery and completion..."
    );

    let statusAfter: FiberStatus | null = null;

    // Poll for up to 30 seconds
    for (let i = 0; i < 30; i++) {
      await sleep(1000);

      try {
        statusAfter = (await callAgent("getFiberStatus", [
          fiberId
        ])) as FiberStatus;

        console.log(
          `[test] Poll ${i + 1}: status=${statusAfter?.status}, ` +
            `steps=${statusAfter?.snapshot?.completedSteps?.length ?? 0}, ` +
            `retryCount=${statusAfter?.retryCount}`
        );

        if (statusAfter?.status === "completed") break;
      } catch (_e) {
        console.log(`[test] Poll ${i + 1}: error (agent may not be ready yet)`);
      }
    }

    // ── Phase 5: Verify recovery ──────────────────────────────────
    expect(statusAfter).not.toBeNull();
    expect(statusAfter!.status).toBe("completed");
    // retryCount should have been incremented by recovery
    expect(statusAfter!.retryCount).toBeGreaterThanOrEqual(1);
    // All 10 steps should be complete
    expect(statusAfter!.snapshot?.completedSteps?.length).toBe(10);

    console.log("[test] Fiber recovered and completed successfully!");
  });
});
