/**
 * E2E test for the #1649 slow-sibling barrier bypass.
 *
 * Spins up a real `wrangler dev` worker, connects over a real WebSocket, and
 * drives ThinkParallelClientToolE2EAgent (deterministic mock model emitting two
 * parallel client tool calls). The fast sibling is answered mid-stream; the
 * slow sibling only after the stream has ended. The continuation barrier must
 * hold for the slow sibling so it ends `output-available` instead of being
 * errored by the transcript-repair backstop.
 *
 * Unlike the in-process (vitest-pool-workers) test, this exercises a real
 * process boundary, the real scheduler, and a real socket — the conditions
 * under which the customer originally hit the bug.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { setDefaultAutoSelectFamily } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

setDefaultAutoSelectFamily(false);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18799;
const BASE_URL = `http://localhost:${PORT}`;
const AGENT_SLUG = "think-parallel-client-tool-e2-e-agent";
const PERSIST_DIR = path.join(
  __dirname,
  ".wrangler-parallel-client-tool-state"
);

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_TOOL_RESULT = "cf_agent_tool_result";

// ── Process/harness helpers (mirror assistant-e2e.test.ts) ──────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessOnPort(port: number): void {
  try {
    const output = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`)
      .toString()
      .trim();
    if (output) {
      for (const pid of output.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // ignore
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
    // pgrep may be unavailable
  }
  for (const childPid of children) killProcessTree(childPid);
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
      const res = await fetch(`${BASE_URL}/`);
      await res.body?.cancel();
      if (res.status > 0) return;
    } catch {
      // not ready yet
    }
    await sleep(delayMs);
  }
  throw new Error(`Wrangler did not start within ${maxAttempts * delayMs}ms`);
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

// ── Agent helpers ───────────────────────────────────────────────────────

function openWS(room: string): Promise<WebSocket> {
  const url = `${BASE_URL}/agents/${AGENT_SLUG}/${room}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket connection timed out"));
    }, 10000);
    ws.onopen = () => {
      clearTimeout(timeout);
      resolve(ws);
    };
    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

/** Call a @callable method over a short-lived WebSocket RPC. */
function callAgent(
  room: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `${BASE_URL}/agents/${AGENT_SLUG}/${room}`;
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
          if (msg.success) resolve(msg.result);
          else reject(new Error(msg.error || "RPC failed"));
        }
      } catch {
        // ignore non-RPC frames
      }
    };
    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

function drainInitialMessages(
  ws: WebSocket,
  count = 3,
  timeout = 5000
): Promise<void> {
  return new Promise((resolve) => {
    let received = 0;
    const timer = setTimeout(() => resolve(), timeout);
    const handler = () => {
      received++;
      if (received >= count) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve();
      }
    };
    ws.addEventListener("message", handler);
  });
}

function sendChatRequest(
  ws: WebSocket,
  text: string,
  clientTools: Array<{ name: string; description: string }>
): string {
  const id = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id,
      init: {
        method: "POST",
        body: JSON.stringify({
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text }]
            }
          ],
          clientTools
        })
      }
    })
  );
  return id;
}

function sendToolResult(
  ws: WebSocket,
  toolCallId: string,
  output: string
): void {
  ws.send(
    JSON.stringify({
      type: MSG_TOOL_RESULT,
      toolCallId,
      toolName: "client_action",
      output,
      autoContinue: true
    })
  );
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error("waitUntil timed out");
}

// ── Test ──────────────────────────────────────────────────────────────

describe("think e2e — parallel client tool slow sibling (#1649)", () => {
  let wrangler: ChildProcess | null = null;

  beforeAll(async () => {
    killProcessOnPort(PORT);
    wrangler = startWrangler();
    await waitForReady();
    console.log("[test] Wrangler is ready");
  });

  afterAll(async () => {
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

  it("does not error a slow client tool when a fast sibling auto-continues mid-stream", async () => {
    const room = `e2e-parallel-${Date.now()}`;
    const ws = await openWS(room);
    await drainInitialMessages(ws);

    sendChatRequest(ws, "delete the 4th slide and rewrite the 1st", [
      { name: "client_action", description: "A client tool" }
    ]);

    // Wait until both parallel calls are exposed in the streaming accumulator.
    await waitUntil(async () => {
      const fast = await callAgent(room, "streamingToolState", ["tc-fast"]);
      const slow = await callAgent(room, "streamingToolState", ["tc-slow"]);
      return fast === "input-available" && slow === "input-available";
    }, 15000);

    // Answer the FAST tool mid-stream with autoContinue (schedules the
    // continuation; its 50ms barrier timer fires while the message is still
    // only in the accumulator — the slow-sibling bypass window).
    sendToolResult(ws, "tc-fast", "fast output");

    // Let the stream finish and persist (tc-slow still pending) WITHOUT
    // answering the slow tool — `_streamingAssistant` cleared.
    await waitUntil(async () => {
      const slow = await callAgent(room, "streamingToolState", ["tc-slow"]);
      return slow === undefined;
    }, 15000);

    // On `main` the bypassed continuation runs here and errors tc-slow; the
    // barrier must instead still be holding.
    await sleep(500);

    // The slow RPC finally resolves, well after the stream ended.
    sendToolResult(ws, "tc-slow", "slow output");

    // The continuation runs only once the slow result is recorded.
    await waitUntil(async () => {
      const count = (await callAgent(room, "continuationCount", [])) as number;
      return count >= 1;
    }, 15000);
    await sleep(200);

    const states = (await callAgent(room, "toolStates", [])) as Record<
      string,
      { state?: string; output?: string }
    >;
    expect(states["tc-fast"]?.state).toBe("output-available");
    expect(states["tc-slow"]?.state).toBe("output-available");
    expect(states["tc-slow"]?.output).toBe("slow output");

    const continuationCount = (await callAgent(
      room,
      "continuationCount",
      []
    )) as number;
    expect(continuationCount).toBe(1);

    ws.close();
  }, 90000);
});
