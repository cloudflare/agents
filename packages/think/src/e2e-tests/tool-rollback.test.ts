/**
 * E2E: rollback DEPTH under rapid kill/restart churn (tool-result durability).
 *
 * Reproduces the customer's "completed tool calls re-run / rollback past several
 * steps" report. A single long turn runs many `recordStep` tool steps; each
 * execution appends a ledger row. We SIGKILL + restart wrangler repeatedly while
 * the turn is in flight (far faster than a real ~33s deploy, matching a chaos
 * environment), then measure:
 *
 *   reRuns      = totalExecutions - uniqueIndices
 *   evictions   = recoveryCount (onChatRecovery fires once per detected eviction)
 *
 * If reRuns ≈ evictions, the framework bound holds ("at most the single
 * in-flight step re-runs per eviction") and the customer's fix is tool
 * idempotency. If reRuns >> evictions, recovery is rolling back PAST completed
 * steps — a framework reconstruction gap.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { setDefaultAutoSelectFamily } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

// Disable happy-eyeballs dual-stack racing (see chat-recovery.test.ts).
setDefaultAutoSelectFamily(false);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18796;
const AGENT_URL = `http://127.0.0.1:${PORT}`;
const AGENT_SLUG = "think-tool-rollback-e2-e-agent";
const AGENT_NAME = "tool-rollback-e2e";
const PERSIST_DIR = path.join(__dirname, ".wrangler-tool-rollback-state");
const TOTAL_STEPS = 30;

type LedgerStatus = {
  totalExecutions: number;
  uniqueIndices: number;
  maxIndex: number;
  duplicates: Array<{ index: number; count: number }>;
  recoveryCount: number;
  assistantMessages: number;
  hasFiberRows: boolean;
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
        // ignore non-rpc frames
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`RPC ${method} socket error`));
    };
  });
}

async function readLedger(): Promise<LedgerStatus | null> {
  try {
    return (await callAgent("getLedgerStatus")) as LedgerStatus;
  } catch {
    return null;
  }
}

describe("tool rollback under rapid churn", () => {
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

  it("recovers a long tool loop across repeated evictions without deep rollback", async () => {
    wrangler = startWrangler();
    await waitForReady();

    await sendChatMessage("seed everything in order");

    // Rapid churn while the turn runs (each cycle ~ kill + boot, a few seconds).
    for (let i = 0; i < 4; i++) {
      await sleep(2500);
      console.log(`[tool-rollback] churn cycle ${i + 1}`);
      wrangler = await restartWrangler(wrangler);
    }

    // Settle: let recovery drive the loop to completion.
    let status: LedgerStatus | null = null;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(2500);
      status = await readLedger();
      if (status) {
        console.log(
          `[tool-rollback] poll: maxIndex=${status.maxIndex} unique=${status.uniqueIndices} total=${status.totalExecutions} recoveries=${status.recoveryCount} fibers=${status.hasFiberRows}`
        );
        if (status.maxIndex >= TOTAL_STEPS && !status.hasFiberRows) break;
      }
    }

    expect(status).not.toBeNull();
    const final = status as LedgerStatus;
    const reRuns = final.totalExecutions - final.uniqueIndices;
    const summary = {
      at: new Date().toISOString(),
      unique: final.uniqueIndices,
      totalSteps: TOTAL_STEPS,
      total: final.totalExecutions,
      reRuns,
      evictions: final.recoveryCount,
      duplicates: final.duplicates,
      assistantMessages: final.assistantMessages,
      verdict:
        final.uniqueIndices < TOTAL_STEPS
          ? "INCOMPLETE"
          : reRuns <= final.recoveryCount + 1
            ? "BOUNDED"
            : "DEEP_ROLLBACK"
    };
    console.log(`[tool-rollback] FINAL: ${JSON.stringify(summary)}`);
    try {
      fs.appendFileSync(
        "/tmp/tool-rollback.log",
        `${JSON.stringify(summary)}\n`
      );
    } catch {
      // best-effort
    }

    // Forward progress: every step eventually ran (recovery is not abandoning).
    expect(final.uniqueIndices).toBe(TOTAL_STEPS);
    // Rollback-depth bound: recovery should re-run AT MOST the single in-flight
    // step per eviction. If reRuns greatly exceeds the eviction count, recovery
    // is rolling back past already-completed steps (a framework gap).
    expect(reRuns).toBeLessThanOrEqual(final.recoveryCount + 1);
  });
});
