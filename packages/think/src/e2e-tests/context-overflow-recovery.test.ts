/**
 * E2E test: Think context-overflow compaction recovery (in-process; no kills).
 *
 * Runs the agent inside a real `wrangler dev` Workers runtime and drives a chat
 * turn via a `@callable` RPC. A mock model surfaces an in-stream provider
 * context-overflow error; Think's opt-in `contextOverflow` recovery:
 *  - REACTIVE recover: compact + retry, the retry succeeds, final answer present.
 *  - REACTIVE exhaust: model keeps overflowing, retry budget spent → terminal
 *    overflow error surfaced (classified `context_overflow`).
 *  - PROACTIVE: model-reported usage crosses the headroom budget → pre-step
 *    compaction runs before the provider ever rejects.
 *
 * No process kills: the overflow is injected deterministically via the model, so
 * this exercises the full recovery path quickly and reliably.
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
const PORT = 18810;
const AGENT_URL = `http://localhost:${PORT}`;
const AGENT_SLUG = "think-context-overflow-e2-e-agent";
const PERSIST_DIR = path.join(__dirname, ".wrangler-think-overflow-e2e-state");

type OverflowChatOutcome = {
  done: boolean;
  error: string | null;
  compactionCount: number;
  compactionReasons: string[];
  modelCalls: number;
  assistantMessages: number;
  finalText: string;
  errorClassification: string | null;
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

describe("Think context-overflow recovery e2e", () => {
  let wrangler: ChildProcess | null = null;

  beforeEach(async () => {
    killProcessOnPort(PORT);
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK
    }
    wrangler = startWrangler();
    await waitForReady();
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

  it("reactive: compacts and retries an overflowing turn to a successful answer", async () => {
    const outcome = (await callAgent(
      "overflow-reactive-recover",
      "runOverflowChat",
      ["Summarize the long history", "recover"]
    )) as OverflowChatOutcome;

    // The turn completed (no terminal error) after a compact-and-retry.
    expect(outcome.done).toBe(true);
    expect(outcome.error).toBeNull();
    // Compaction actually ran (reactive backstop), and the model was invoked
    // more than once (overflow attempt + recovered retry).
    expect(outcome.compactionCount).toBeGreaterThanOrEqual(1);
    expect(outcome.compactionReasons).toContain("reactive");
    expect(outcome.modelCalls).toBeGreaterThanOrEqual(2);
    // The recovered assistant message is the final answer; the truncated partial
    // is intentionally not persisted as a separate orphan.
    expect(outcome.finalText).toContain("recovered after compaction");
    expect(outcome.finalText).not.toContain("partial answer before overflow");
  });

  it("reactive: surfaces a terminal overflow error when the retry budget is exhausted", async () => {
    const outcome = (await callAgent(
      "overflow-reactive-exhaust",
      "runOverflowChat",
      ["Summarize the long history", "exhaust"]
    )) as OverflowChatOutcome;

    // maxRetries (default 1) spent: the overflow surfaces terminally, classified
    // as context_overflow, and the turn never loops or ends silently.
    expect(outcome.error).not.toBeNull();
    expect(outcome.error ?? "").toContain("prompt is too long");
    expect(outcome.errorClassification).toBe("context_overflow");
    // Compaction was attempted on the (single) retry before giving up.
    expect(outcome.compactionCount).toBeGreaterThanOrEqual(1);
    expect(outcome.compactionReasons).toContain("reactive");
  });

  it("proactive: compacts pre-step when reported usage crosses the headroom budget", async () => {
    const outcome = (await callAgent("overflow-proactive", "runOverflowChat", [
      "Do an echo step then answer",
      "proactive"
    ])) as OverflowChatOutcome;

    // The turn completed without ever hitting a provider overflow because the
    // proactive guard compacted in place before step 2.
    expect(outcome.done).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.compactionCount).toBeGreaterThanOrEqual(1);
    expect(outcome.compactionReasons).toContain("proactive");
    expect(outcome.finalText).toContain("answered with headroom to spare");
  });
});
