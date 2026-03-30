/**
 * E2E tests for @cloudflare/think AssistantAgent.
 *
 * Spins up wrangler dev with a real worker that uses Workers AI,
 * connects via WebSocket, and exercises session management,
 * streaming chat, and workspace tool usage with a real LLM.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18798;
const BASE_URL = `http://localhost:${PORT}`;
const AGENT_SLUG = "test-assistant";
const PERSIST_DIR = path.join(__dirname, ".wrangler-e2e-state");

// Wire protocol constants (must match agent.ts)
const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";
const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

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
    // ignore
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
      const res = await fetch(`${BASE_URL}/`);
      if (res.status > 0) return;
    } catch {
      // Not ready yet
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
    child.on("exit", () => resolve());
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }
    setTimeout(resolve, 3000);
  });
}

/**
 * Call a @callable method on the agent via WebSocket RPC.
 */
async function callAgent(
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
        // Ignore non-RPC messages
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

/**
 * Open a persistent WebSocket to the agent.
 */
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

/**
 * Send a chat request over the WebSocket and collect streamed response chunks
 * until the done message arrives.
 */
function sendChatAndWaitForDone(
  ws: WebSocket,
  text: string,
  timeout = 60000
): Promise<{
  requestId: string;
  chunks: Array<Record<string, unknown>>;
  done: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const chunks: Array<Record<string, unknown>> = [];

    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("Chat response timed out"));
    }, timeout);

    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type === MSG_CHAT_RESPONSE && msg.id === requestId) {
          if (msg.done === true) {
            clearTimeout(timer);
            ws.removeEventListener("message", handler);
            resolve({ requestId, chunks, done: msg });
          } else {
            chunks.push(msg);
          }
        }
      } catch {
        // ignore
      }
    };

    ws.addEventListener("message", handler);

    // Send the chat request
    ws.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
        id: requestId,
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text }]
              }
            ]
          })
        }
      })
    );
  });
}

/**
 * Wait for the next cf_agent_chat_messages broadcast.
 */
function waitForMessagesBroadcast(
  ws: WebSocket,
  timeout = 10000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("Messages broadcast timed out"));
    }, timeout);

    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type === MSG_CHAT_MESSAGES) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(msg);
        }
      } catch {
        // ignore
      }
    };

    ws.addEventListener("message", handler);
  });
}

/**
 * Drain initial WebSocket messages (identity, state, mcp_servers, etc.)
 */
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

// ── Tests ─────────────────────────────────────────────────────────────

describe("think e2e — real LLM", () => {
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

  it("streams a real LLM response", async () => {
    const room = `e2e-stream-${Date.now()}`;

    const ws = await openWS(room);
    await drainInitialMessages(ws);

    // Send a simple chat message
    const { chunks, done } = await sendChatAndWaitForDone(
      ws,
      "Say hello in exactly one word."
    );

    // Should have received streaming chunks
    expect(chunks.length).toBeGreaterThan(0);

    // Done message should not be an error
    expect(done.error).toBeFalsy();

    // Chunks should contain text-delta events
    const bodies = chunks
      .map((c) => {
        try {
          return JSON.parse(c.body as string) as { type: string };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const hasTextDelta = bodies.some((b) => b!.type === "text-delta");
    expect(hasTextDelta).toBe(true);

    ws.close();
  });

  it("persists messages after streaming", async () => {
    const room = `e2e-persist-${Date.now()}`;

    const ws = await openWS(room);
    await drainInitialMessages(ws);

    // Send a chat message and wait for completion
    const broadcastPromise = waitForMessagesBroadcast(ws);
    await sendChatAndWaitForDone(ws, "Say hello.");
    await broadcastPromise;

    // Check persisted messages via RPC
    const messages = (await callAgent(room, "getMessages")) as Array<{
      role: string;
    }>;
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");

    ws.close();
  });

  it("uses workspace tools to write and read a file", async () => {
    const room = `e2e-tools-${Date.now()}`;

    const ws = await openWS(room);
    await drainInitialMessages(ws);

    // Ask the LLM to write a file
    await sendChatAndWaitForDone(
      ws,
      'Use the write tool to create a file at /hello.txt with the content "Hello from e2e test"'
    );

    // Wait for persistence
    await waitForMessagesBroadcast(ws).catch(() => {
      // timeout OK — message may have already been received
    });

    // Now ask the LLM to read it back
    const { chunks: readChunks } = await sendChatAndWaitForDone(
      ws,
      "Use the read tool to read /hello.txt and tell me what it says"
    );

    // The response should mention the file content
    const allText = readChunks
      .map((c) => {
        try {
          const parsed = JSON.parse(c.body as string) as {
            type: string;
            delta?: string;
          };
          return parsed.type === "text-delta" ? parsed.delta : "";
        } catch {
          return "";
        }
      })
      .join("");

    // The LLM should have read and relayed the file content
    expect(allText.toLowerCase()).toContain("hello");

    ws.close();
  });

  it("multi-turn conversation maintains context", async () => {
    const room = `e2e-multi-${Date.now()}`;

    const ws = await openWS(room);
    await drainInitialMessages(ws);

    // First turn
    await sendChatAndWaitForDone(ws, "My name is TestBot.");
    await waitForMessagesBroadcast(ws).catch(() => {});

    // Second turn — the LLM should remember the name
    const { chunks } = await sendChatAndWaitForDone(
      ws,
      "What is my name? Reply with just the name."
    );

    const allText = chunks
      .map((c) => {
        try {
          const parsed = JSON.parse(c.body as string) as {
            type: string;
            delta?: string;
          };
          return parsed.type === "text-delta" ? parsed.delta : "";
        } catch {
          return "";
        }
      })
      .join("");

    expect(allText.toLowerCase()).toContain("testbot");

    ws.close();
  });
});
