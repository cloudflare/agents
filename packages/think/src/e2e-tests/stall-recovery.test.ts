/**
 * E2E: a stream-stall watchdog abort routes into bounded recovery instead of a
 * terminal error (#1626).
 *
 * The agent's model streams a little text on its FIRST inference then hangs
 * forever (a parked provider/transport). With `chatStreamStallTimeoutMs` armed
 * and chatRecovery on, the inactivity watchdog aborts that attempt and routes
 * it into bounded recovery; the framework's real alarm fires the scheduled
 * continuation, whose (non-stalling) inference completes the turn. No process
 * kill is involved — a stall is an in-isolate hang.
 *
 * Asserts the turn RECOVERS (a completed assistant message containing the
 * continuation's output appears, no orphaned fiber rows), rather than ending in
 * a terminal stream error.
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
const PORT = 18798;
const AGENT_URL = `http://127.0.0.1:${PORT}`;
const AGENT_SLUG = "think-stall-recovery-e2-e-agent";
const AGENT_NAME = "stall-recovery-e2e";
const PERSIST_DIR = path.join(__dirname, ".wrangler-stall-recovery-state");

type StallStatus = {
  assistantMessages: number;
  finalText: string;
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
      // Don't wait for done — the first attempt stalls; return once sent.
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

async function callAgent(method: string): Promise<unknown> {
  const url = `${AGENT_URL}/agents/${AGENT_SLUG}/${AGENT_NAME}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC ${method} timed out`));
    }, 10000);
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "rpc", id, method, args: [] }));
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

async function readStatus(): Promise<StallStatus | null> {
  try {
    return (await callAgent("getStallStatus")) as StallStatus;
  } catch {
    return null;
  }
}

describe("stream-stall watchdog routes into bounded recovery", () => {
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

  it("recovers a stalled turn via the scheduled continuation instead of failing terminally (#1626)", async () => {
    wrangler = startWrangler();
    await waitForReady();

    await sendChatMessage("stall then recover");

    // Wait for: watchdog (~2s) → schedule continue → real alarm fires →
    // continuation streams the rest → turn completes with no orphaned fibers.
    let status: StallStatus | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(2500);
      status = await readStatus();
      if (status) {
        console.log(`[stall-recovery] poll: ${JSON.stringify(status)}`);
        if (status.finalText.includes("RECOVERED") && !status.hasFiberRows) {
          break;
        }
      }
    }

    expect(status).not.toBeNull();
    const final = status as StallStatus;
    console.log(`[stall-recovery] FINAL: ${JSON.stringify(final)}`);

    // The turn recovered: the continuation's output landed in a completed
    // assistant message (rather than a terminal stream error), and no orphaned
    // fiber rows remain.
    expect(final.assistantMessages).toBeGreaterThanOrEqual(1);
    expect(final.finalText).toContain("RECOVERED");
    expect(final.hasFiberRows).toBe(false);
  }, 120_000);
});
