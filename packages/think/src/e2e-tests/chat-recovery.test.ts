/**
 * E2E test: Think chat recovery after process eviction.
 *
 * 1. Start wrangler dev with ThinkRecoveryE2EAgent
 * 2. Send a chat message via WebSocket (starts a slow stream inside runFiber)
 * 3. Kill the process mid-stream (SIGKILL — simulates real DO eviction)
 * 4. Restart wrangler with the same persist directory
 * 5. Verify: onChatRecovery fired, partial text persisted, fiber row cleaned up
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18797;
const AGENT_URL = `http://localhost:${PORT}`;
const AGENT_NAME = "think-recovery-e2e";
const AGENT_SLUG = "think-recovery-e2-e-agent";
const HELPER_PARENT_NAME = "think-helper-recovery-e2e";
const HELPER_PARENT_SLUG = "think-recovery-helper-parent";
const HELPER_NAME = "helper-recovery-e2e";
const PERSIST_DIR = path.join(__dirname, ".wrangler-think-recovery-e2e-state");

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
      const res = await fetch(`${AGENT_URL}/`);
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
      await fetch(`${AGENT_URL}/`);
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

async function callAgentByPath(
  path: string,
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `${AGENT_URL}${path}`;

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

async function callAgent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return callAgentByPath(`/agents/${AGENT_SLUG}/${AGENT_NAME}`, method, args);
}

async function callHelperParent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  return callAgentByPath(
    `/agents/${HELPER_PARENT_SLUG}/${HELPER_PARENT_NAME}`,
    method,
    args
  );
}

function sendChatMessage(userMessage: string): Promise<void> {
  const url = `${AGENT_URL}/agents/${AGENT_SLUG}/${AGENT_NAME}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    const timeout = setTimeout(() => {
      ws.close();
      resolve();
    }, 3000);

    ws.onopen = () => {
      const requestId = crypto.randomUUID();
      const body = JSON.stringify({
        messages: [
          {
            id: `user-${Date.now()}`,
            role: "user",
            parts: [{ type: "text", text: userMessage }]
          }
        ]
      });

      ws.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: requestId,
          init: { method: "POST", body }
        })
      );

      // Wait for a few chunks to stream before we kill
      setTimeout(() => {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }, 2000);
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

describe("Think chat recovery e2e", () => {
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

  it("should recover chat after process kill via persisted alarm", async () => {
    // 1. Start wrangler
    wrangler = startWrangler();
    await waitForReady();

    // 2. Send a chat message (starts slow stream inside runFiber)
    await sendChatMessage("Tell me a long story");

    // 3. Wait for a few chunks to stream
    // ResumableStream flushes chunks in batches. Wait long enough for the
    // slow mock model to cross the flush threshold before killing workerd, so
    // recovery sees a non-empty partial response instead of only a fiber row.
    await sleep(6000);

    // Verify fiber row exists (stream is in progress)
    const hasFibers = (await callAgent("hasFiberRows")) as boolean;
    console.log(`[test] Fiber rows before kill: ${hasFibers}`);

    // 4. Kill the process mid-stream
    console.log("[test] Killing wrangler (SIGKILL)...");
    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree();

    // 5. Restart wrangler with the same persist directory
    console.log("[test] Restarting wrangler...");
    wrangler = startWrangler();
    await waitForReady();
    console.log("[test] Wrangler restarted");

    // 6. Wait for alarm to fire and recovery to complete
    let recovered = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const status = (await callAgent("getRecoveryStatus")) as {
          recoveryCount: number;
          messageCount: number;
          assistantMessages: number;
        };
        console.log(
          `[test] Poll ${i + 1}: recovered=${status.recoveryCount}, messages=${status.messageCount}, assistant=${status.assistantMessages}`
        );
        if (status.recoveryCount > 0) {
          recovered = true;
          break;
        }
      } catch {
        console.log(`[test] Poll ${i + 1}: error (agent not ready)`);
      }
    }

    // 7. Verify recovery
    expect(recovered).toBe(true);

    const status = (await callAgent("getRecoveryStatus")) as {
      recoveryCount: number;
      contexts: Array<{
        streamId: string;
        requestId: string;
        partialText: string;
      }>;
      messageCount: number;
      assistantMessages: number;
    };

    expect(status.recoveryCount).toBeGreaterThanOrEqual(1);
    // Partial text should contain some chunks that streamed before the kill
    expect(status.contexts[0].partialText.length).toBeGreaterThan(0);

    // Fiber rows should be cleaned up after recovery
    const fiberRowsAfter = (await callAgent("hasFiberRows")) as boolean;
    expect(fiberRowsAfter).toBe(false);
  });

  it("should recover helper sub-agent chat after process kill via parent alarm", async () => {
    wrangler = startWrangler();
    await waitForReady();

    await callHelperParent("startHelperChatTurn", [
      HELPER_NAME,
      "Tell me a helper story"
    ]);

    const hasFibers = (await callHelperParent("helperHasFiberRows", [
      HELPER_NAME
    ])) as boolean;
    console.log(`[test] Helper fiber rows before kill: ${hasFibers}`);
    expect(hasFibers).toBe(true);

    console.log("[test] Killing wrangler (SIGKILL)...");
    await killProcess(wrangler);
    wrangler = null;
    await waitForPortFree();

    console.log("[test] Restarting wrangler...");
    wrangler = startWrangler();
    await waitForReady();
    console.log("[test] Wrangler restarted");

    let recovered = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const status = (await callHelperParent("getHelperRecoveryStatus", [
          HELPER_NAME
        ])) as {
          recoveryCount: number;
          messageCount: number;
          assistantMessages: number;
        };
        console.log(
          `[test] Helper poll ${i + 1}: recovered=${status.recoveryCount}, messages=${status.messageCount}, assistant=${status.assistantMessages}`
        );
        if (status.recoveryCount > 0) {
          recovered = true;
          break;
        }
      } catch {
        console.log(`[test] Helper poll ${i + 1}: error (agent not ready)`);
      }
    }

    expect(recovered).toBe(true);

    const status = (await callHelperParent("getHelperRecoveryStatus", [
      HELPER_NAME
    ])) as {
      recoveryCount: number;
      contexts: Array<{
        streamId: string;
        requestId: string;
        partialText: string;
      }>;
      messageCount: number;
      assistantMessages: number;
    };

    expect(status.recoveryCount).toBeGreaterThanOrEqual(1);
    expect(status.contexts[0].partialText.length).toBeGreaterThan(0);

    const fiberRowsAfter = (await callHelperParent("helperHasFiberRows", [
      HELPER_NAME
    ])) as boolean;
    expect(fiberRowsAfter).toBe(false);
  });
});
