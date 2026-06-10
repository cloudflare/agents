/**
 * E2E test: Think messenger reply-fiber recovery after process eviction.
 *
 * A `MESSENGER_REPLY_FIBER_NAME` fiber interrupted by a SIGKILL is recovered on
 * the next DO start through `_handleInternalFiberRecovery` →
 * `ThinkMessengerRuntime.handleFiberRecovery`:
 *  - an `accepted`-stage snapshot recovers in "answer" mode (the reply resumes
 *    and the model answer is posted to the thread)
 *  - a `streaming`-stage snapshot recovers in "apologize" mode (an interrupted
 *    message is posted)
 *
 * The reply fiber is started for real (it stashes the target stage and parks),
 * then killed mid-flight. Recovery posts through an in-memory fake `chat`
 * adapter that records into agent SQL.
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
const PORT = 18812;
const AGENT_URL = `http://localhost:${PORT}`;
const AGENT_SLUG = "think-messenger-recovery-e2-e-agent";
const INTERRUPTED_TEXT = "Reply interrupted, please retry.";
const PERSIST_DIR = path.join(__dirname, ".wrangler-think-messenger-e2e-state");

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

async function startAndInterruptReply(
  agent: string,
  mode: "answer" | "apologize"
): Promise<void> {
  await callAgent(agent, "startReplyFiber", [mode]);
  // Confirm the reply fiber is in-flight (run row exists) before killing.
  await pollUntil(
    "messenger reply fiber in-flight",
    () => callAgent(agent, "hasFiberRows") as Promise<boolean>,
    (has) => has === true,
    { attempts: 20, delayMs: 250 }
  );
}

describe("Think messenger reply recovery e2e", () => {
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

  it("posts an interrupted apology when a mid-stream reply fiber is recovered", async () => {
    const agent = "messenger-apologize";

    wrangler = startWrangler();
    await waitForReady();

    await startAndInterruptReply(agent, "apologize");

    wrangler = await restartWrangler(wrangler);

    const posts = await pollUntil(
      "messenger posts (apologize)",
      () => callAgent(agent, "getPostedMessages") as Promise<string[]>,
      (entries) => entries.some((entry) => entry.includes(INTERRUPTED_TEXT)),
      { attempts: 40, delayMs: 500 }
    );
    expect(posts.some((entry) => entry.includes(INTERRUPTED_TEXT))).toBe(true);

    // The orphaned reply fiber row is cleaned up once recovery resolves it.
    const cleared = await pollUntil(
      "messenger fiber cleanup (apologize)",
      () => callAgent(agent, "hasFiberRows") as Promise<boolean>,
      (has) => has === false,
      { attempts: 40, delayMs: 500 }
    );
    expect(cleared).toBe(false);
  });

  it("recovers an accepted-stage fiber in answer mode and re-drives the reply delivery", async () => {
    const agent = "messenger-answer";

    wrangler = startWrangler();
    await waitForReady();

    await startAndInterruptReply(agent, "answer");

    wrangler = await restartWrangler(wrangler);

    // Answer mode re-runs the reply: recovery resumes the model turn and drives
    // delivery to the thread, posting to the (in-memory) adapter.
    //
    // NOTE: a successful streamed answer is delivered via the chat SDK Thread's
    // streaming-edit path. The minimal in-memory fake adapter here records posts
    // but does not fully implement that streaming-edit surface, so the final
    // rendered answer text is not asserted (deferred — would need a complete
    // adapter or a real transport). What this proves end-to-end is that the
    // interrupted reply fiber is detected on restart, recovered in ANSWER mode
    // (not apologize), and re-drives the reply delivery — i.e. the
    // `_handleInternalFiberRecovery` → messenger `handleFiberRecovery` → thread
    // revival → delivery path runs.
    const posts = await pollUntil(
      "messenger posts (answer)",
      () => callAgent(agent, "getPostedMessages") as Promise<string[]>,
      (entries) => entries.length > 0,
      { attempts: 60, delayMs: 1000 }
    );
    expect(posts.length).toBeGreaterThan(0);
    // Answer mode does NOT short-circuit to the streaming-interrupt apology.
    expect(posts.some((entry) => entry.includes(INTERRUPTED_TEXT))).toBe(false);

    const cleared = await pollUntil(
      "messenger fiber cleanup (answer)",
      () => callAgent(agent, "hasFiberRows") as Promise<boolean>,
      (has) => has === false,
      { attempts: 40, delayMs: 500 }
    );
    expect(cleared).toBe(false);
  });
});
