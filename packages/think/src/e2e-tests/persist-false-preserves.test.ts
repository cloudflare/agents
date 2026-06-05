/**
 * E2E: `onChatRecovery` returning `{ persist: false, continue: false }` must
 * NOT drop settled tool results under a REAL process kill (#1631 / R1).
 *
 * A turn runs a `recordStep` tool loop (each execution settles a non-idempotent
 * ledger row). We let a few steps settle, SIGKILL + restart wrangler mid-turn,
 * and the agent's `onChatRecovery` returns `{ persist: false, continue: false }`
 * — the explicit "stop this turn" override. The R1 default guarantees the
 * settled tool results produced before the kill are still materialized into the
 * durable transcript (never dropped), while `continue: false` stops the turn.
 *
 * Without R1 (the old "persist:false discards the partial" behavior), the
 * transcript would have ZERO settled tool parts after recovery — so this test
 * fails on the pre-R1 code and passes after it.
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
const PORT = 18797;
const AGENT_URL = `http://127.0.0.1:${PORT}`;
const AGENT_SLUG = "think-persist-false-e2-e-agent";
const AGENT_NAME = "persist-false-e2e";
const PERSIST_DIR = path.join(__dirname, ".wrangler-persist-false-state");
const TOTAL_STEPS = 30;

type PersistFalseStatus = {
  totalExecutions: number;
  uniqueIndices: number;
  maxIndex: number;
  recoveryCount: number;
  assistantMessages: number;
  settledToolPartsInTranscript: number;
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
      }, 1500);
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

async function readStatus(): Promise<PersistFalseStatus | null> {
  try {
    return (await callAgent("getPersistFalseStatus")) as PersistFalseStatus;
  } catch {
    return null;
  }
}

describe("persist:false preserves settled work under a real kill", () => {
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

  it("keeps settled tool results in the transcript when recovery returns { persist: false } (#1631 R1)", async () => {
    wrangler = startWrangler();
    await waitForReady();

    await sendChatMessage("record steps in order");

    // Let a few steps settle (each ~600ms), then SIGKILL mid-turn so recovery
    // fires on restart and returns { persist: false, continue: false }.
    await sleep(3000);
    wrangler = await restartWrangler(wrangler);

    // Settle: wait for recovery to fire and the turn to stop (continue:false).
    let status: PersistFalseStatus | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(2500);
      status = await readStatus();
      if (status) {
        console.log(
          `[persist-false] poll: maxIndex=${status.maxIndex} unique=${status.uniqueIndices} settledInTranscript=${status.settledToolPartsInTranscript} recoveries=${status.recoveryCount} fibers=${status.hasFiberRows}`
        );
        if (status.recoveryCount >= 1 && !status.hasFiberRows) break;
      }
    }

    expect(status).not.toBeNull();
    const final = status as PersistFalseStatus;
    console.log(`[persist-false] FINAL: ${JSON.stringify(final)}`);

    // Recovery fired and returned persist:false/continue:false.
    expect(final.recoveryCount).toBeGreaterThanOrEqual(1);
    // R1: the settled tool results produced before the kill are preserved in
    // the durable transcript (the headline guarantee). Pre-R1 this would be 0.
    expect(final.settledToolPartsInTranscript).toBeGreaterThanOrEqual(1);
    // At least one ledger step actually settled before the kill.
    expect(final.maxIndex).toBeGreaterThanOrEqual(1);
    // continue:false stopped the turn — it did NOT run to completion.
    expect(final.maxIndex).toBeLessThan(TOTAL_STEPS);
  }, 120_000);
});
