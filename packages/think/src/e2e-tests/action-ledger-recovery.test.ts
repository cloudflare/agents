/**
 * E2E test: a crash-left `pending` action ledger row is reclaimed and re-run by
 * a later invocation across a real deploy (actions RFC pending-retry lease).
 *
 * Drives the full path inside a real `wrangler dev` runtime:
 *  1. seed the crash artifact — a stale `pending` `cf_think_action_ledger` row
 *     for an explicit-key action (exactly what a crashed mid-execute leaves)
 *  2. a real SIGKILL + restart proves the durable row survives the deploy
 *  3. a fresh chat turn calls the same action, finds the now-stale pending row,
 *     reclaims it (lease expired), and runs the side effect to completion
 *     exactly once — never stuck behind a permanent `ActionPendingError`
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
const PORT = 18815;
const AGENT_URL = `http://localhost:${PORT}`;
const AGENT_SLUG = "think-action-ledger-recovery-e2-e-agent";
const PERSIST_DIR = path.join(
  __dirname,
  ".wrangler-think-action-ledger-e2e-state"
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

type LedgerRow = { key: string; status: string; updated_at: number };

describe("Think action ledger pending-retry recovery e2e", () => {
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

  it("reclaims a crash-left pending ledger row after a restart", async () => {
    const agent = "action-ledger-deploy";
    const ledgerKey = "action:slowAction:ledger-recovery-key";

    wrangler = startWrangler();
    await waitForReady();

    // 1. Seed the crash artifact: a stale `pending` ledger row for the
    //    explicit-key action, and confirm the side effect has not run.
    await callAgent(agent, "seedStalePendingRow");
    const seeded = (await callAgent(agent, "listLedgerRows")) as LedgerRow[];
    expect(seeded).toMatchObject([{ key: ledgerKey, status: "pending" }]);
    expect((await callAgent(agent, "getExecCount")) as number).toBe(0);

    // 2. Real deploy churn: SIGKILL + restart with the same persist dir. The
    //    pending row survives (rebuilt from the durable store on cold start).
    wrangler = await restartWrangler(wrangler);

    const survived = (await callAgent(agent, "listLedgerRows")) as LedgerRow[];
    expect(survived).toMatchObject([{ key: ledgerKey, status: "pending" }]);
    expect((await callAgent(agent, "getExecCount")) as number).toBe(0);

    // 3. A fresh turn calls the same action. It finds the now-stale pending
    //    row, reclaims the lease, runs the side effect, and settles.
    const turn = (await callAgent(agent, "runLedgerActionTurn", [
      "do the ledger work"
    ])) as { done: boolean };
    expect(turn.done).toBe(true);

    // The side effect ran exactly once and the row is now settled — no
    // permanent ActionPendingError block.
    expect((await callAgent(agent, "getExecCount")) as number).toBe(1);
    const settled = (await callAgent(agent, "listLedgerRows")) as LedgerRow[];
    expect(settled).toMatchObject([{ key: ledgerKey, status: "settled" }]);

    const finalText = await pollUntil(
      "final assistant text",
      () => callAgent(agent, "getFinalText") as Promise<string>,
      (text) => text.includes("ledger action acknowledged"),
      { attempts: 20, delayMs: 1000 }
    );
    expect(finalText).toContain("ledger action acknowledged");
  });
});
