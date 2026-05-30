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
import { setDefaultAutoSelectFamily } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

// Disable happy-eyeballs dual-stack racing. When a probe `fetch`/WebSocket
// connects to a server that is mid-SIGKILL/restart, the abandoned racing socket
// can throw a connect-time `setTypeOfService` EINVAL that surfaces as an
// unhandled error and fails an otherwise-green chaos run.
setDefaultAutoSelectFamily(false);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18797;
const AGENT_URL = `http://localhost:${PORT}`;
const AGENT_NAME = "think-recovery-e2e";
const AGENT_SLUG = "think-recovery-e2-e-agent";
const HELPER_PARENT_NAME = "think-helper-recovery-e2e";
const HELPER_PARENT_SLUG = "think-recovery-helper-parent";
const HELPER_NAME = "helper-recovery-e2e";
const PERSIST_DIR = path.join(__dirname, ".wrangler-think-recovery-e2e-state");
const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

type RecoveryStatus = {
  recoveryCount: number;
  contexts: Array<{
    streamId: string;
    requestId: string;
    partialText: string;
  }>;
  messageCount: number;
  assistantMessages: number;
};

type AgentToolRunStatus = {
  runId: string;
  status: string;
  error: string | null;
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

async function waitForAgentRecovery(): Promise<RecoveryStatus> {
  return pollUntil(
    "agent recovery",
    () => callAgent("getRecoveryStatus") as Promise<RecoveryStatus>,
    (status) => status.recoveryCount > 0
  );
}

async function waitForHelperRecovery(): Promise<RecoveryStatus> {
  return pollUntil(
    "helper recovery",
    () =>
      callHelperParent("getHelperRecoveryStatus", [
        HELPER_NAME
      ]) as Promise<RecoveryStatus>,
    (status) => status.recoveryCount > 0
  );
}

async function waitForAgentToolRun(
  runId: string,
  predicate: (run: AgentToolRunStatus) => boolean
): Promise<AgentToolRunStatus> {
  const rows = await pollUntil(
    "agent-tool recovery",
    () => callHelperParent("getAgentToolRuns") as Promise<AgentToolRunStatus[]>,
    (runs) => runs.some((run) => run.runId === runId && predicate(run)),
    { attempts: 40, delayMs: 500 }
  );
  const row = rows.find((run) => run.runId === runId);
  if (!row) throw new Error(`Missing agent-tool row ${runId}`);
  return row;
}

function sendChatMessageAndWaitForDone(
  userMessage: string
): Promise<Record<string, unknown>> {
  const url = `${AGENT_URL}/agents/${AGENT_SLUG}/${AGENT_NAME}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for chat response"));
    }, 10000);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: MSG_CHAT_REQUEST,
          id: crypto.randomUUID(),
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: `user-${Date.now()}`,
                  role: "user",
                  parts: [{ type: "text", text: userMessage }]
                }
              ]
            })
          }
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
          clearTimeout(timeout);
          ws.close();
          resolve(msg);
        }
      } catch {
        // Ignore non-chat frames.
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
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
          type: MSG_CHAT_REQUEST,
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

  it("should still recover after repeated restart churn around an interrupted turn", async () => {
    wrangler = startWrangler();
    await waitForReady();

    await sendChatMessage("Tell me a long restart story");
    await sleep(6000);

    expect((await callAgent("hasFiberRows")) as boolean).toBe(true);

    for (let i = 0; i < 2; i++) {
      console.log(`[test] Restart churn cycle ${i + 1}`);
      wrangler = await restartWrangler(wrangler);
      // Keep this intentionally short: the test approximates deploy churn where
      // a fresh isolate can be replaced before recovery work settles.
      await sleep(250);
    }

    const status = await waitForAgentRecovery();
    expect(status.contexts[0].partialText.length).toBeGreaterThan(0);

    const fiberRowsAfter = (await callAgent("hasFiberRows")) as boolean;
    expect(fiberRowsAfter).toBe(false);
  });

  it("should expose the current post-persist chat request failure surface", async () => {
    wrangler = startWrangler();
    await waitForReady();

    await callAgent("throwBeforeNextTurn", ["forced beforeTurn failure"]);

    const response = await sendChatMessageAndWaitForDone(
      "Persist this, then fail before the model turn"
    );
    expect(response.error).toBe(true);
    expect(response.body).toContain("forced beforeTurn failure");

    const status = (await callAgent("getRecoveryStatus")) as RecoveryStatus;
    expect(status.messageCount).toBe(1);
    expect(status.assistantMessages).toBe(0);

    // This documents the observability gap from the report: the request catch
    // broadcasts a chat error frame, but it does not route through onError.
    expect((await callAgent("getOnErrorLog")) as string[]).toEqual([]);
    const chatErrorLog = await pollUntil(
      "chat error hook",
      () => callAgent("getOnChatErrorLog") as Promise<string[]>,
      (log) => log.some((entry) => entry.includes("forced beforeTurn failure")),
      { attempts: 10, delayMs: 250 }
    );
    expect(chatErrorLog).toContain("forced beforeTurn failure");
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

    const status = await waitForHelperRecovery();

    expect(status.recoveryCount).toBeGreaterThanOrEqual(1);
    expect(status.contexts[0].partialText.length).toBeGreaterThan(0);

    const fiberRowsAfter = (await callHelperParent("helperHasFiberRows", [
      HELPER_NAME
    ])) as boolean;
    expect(fiberRowsAfter).toBe(false);
  });

  it("should interrupt a stale parent agent-tool run after parent restart", async () => {
    wrangler = startWrangler();
    await waitForReady();

    const runId = `agent-tool-${Date.now()}`;
    await callHelperParent("startHelperAgentToolRun", [
      runId,
      "Tell me an agent-tool story"
    ]);

    await waitForAgentToolRun(
      runId,
      (run) => run.status === "starting" || run.status === "running"
    );

    console.log("[test] Killing wrangler with active agent-tool run...");
    wrangler = await restartWrangler(wrangler);

    const recoveredRun = await waitForAgentToolRun(
      runId,
      (run) => run.status === "interrupted" || run.status === "error"
    );

    expect(recoveredRun.status).toBe("interrupted");
    expect(recoveredRun.error ?? "").toMatch(
      /still running|timed out|could not be inspected/
    );
  });
});
