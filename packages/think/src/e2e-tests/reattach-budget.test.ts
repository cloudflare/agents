/**
 * E2E (regression gate): a deploy that interrupts a child `runAgentTool` run
 * mid-flight must NOT cause the parent to seal the run `interrupted` while the
 * child is HEALTHY and still making forward progress.
 *
 * Root cause (now fixed): the parent's re-attach is no-progress–keyed off the
 * child's forwarded stream chunks (not a flat wall clock). But a recovered child
 * turn minted a NEW request id via `continueLastTurn` / `_retryLastUserTurn`
 * without updating `cf_agent_tool_child_runs.request_id`, so
 * `_agentToolRunForRequest` could no longer attribute the recovered turn's
 * broadcast frames to the run. No frames reached the parent's tail, its
 * no-progress budget (`agentToolReattachNoProgressTimeoutMs`, 120s) elapsed, and
 * a still-advancing child was abandoned as `interrupted`. The fix
 * (`_rebindAgentToolChildRunRequestId`) re-binds the row + in-memory attribution
 * map to the recovery turn's request id, keeping frames flowing across recovery.
 *
 * Why this is the faithful repro (and why the other task agents don't catch it):
 *   - A child facet cannot arm its own physical alarm (facets share the root
 *     isolate), so it cannot self-drive its recovery the way the parent turn can.
 *   - `ThinkSlowChildParentE2EAgent` / `ThinkSlowChildE2EAgent` use the
 *     PRODUCTION-DEFAULT keepAlive. The rollback/task agents override it to 2s,
 *     which drives facet recovery ~15x faster and lets the child finish inside
 *     the budget — masking the bug.
 *
 * Scenario: parent turn calls one `runTask` (→ child via the natural agentTool()
 * path, stable runId `agent-tool:task-1`). The child is a 60-step ledger loop
 * (~162s of continuous work). We let a few steps land, do ONE deploy (SIGKILL +
 * restart), then watch the parent's collected status for the child run.
 *
 * EXPECTED: parent re-attaches/re-arms until the healthy child reaches its real
 * terminal → `parentChildStatus === "completed"`.
 *
 * NOTE: lives in the manual `think-e2e` project (not the default PR gate).
 * Deterministic unit coverage of the request_id rebind is in
 * `packages/think/src/tests/agent-tool-reattach-recovery.test.ts`.
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
const PORT = 18796;
const AGENT_URL = `http://127.0.0.1:${PORT}`;
const PERSIST_DIR = path.join(__dirname, ".wrangler-reattach-budget-state");
const CHILD_STEPS = 60;

const TARGET = {
  slug: "think-slow-child-parent-e2-e-agent",
  name: "reattach-budget-e2e"
};

type TaskStatus = {
  parentRecoveries: number;
  parentHasFiberRows: boolean;
  parentChildStatus: string | null;
  parentChildError: string | null;
  child: {
    maxIndex: number;
    uniqueIndices: number;
    recoveryCount: number;
    hasFiberRows: boolean;
  } | null;
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
  const url = `${AGENT_URL}/agents/${TARGET.slug}/${TARGET.name}`;
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
  const url = `${AGENT_URL}/agents/${TARGET.slug}/${TARGET.name}`;
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
        // ignore
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`RPC ${method} socket error`));
    };
  });
}

async function readStatus(): Promise<TaskStatus | null> {
  try {
    return (await callAgent("getTaskStatus")) as TaskStatus;
  } catch {
    return null;
  }
}

const TERMINAL_STATUSES = new Set(["completed", "error", "aborted"]);

describe("agent-tool re-attach budget under a single deploy", () => {
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

  // Re-enabled: the root cause was that a recovered child turn minted a NEW
  // request id without re-binding `cf_agent_tool_child_runs.request_id`, so the
  // parent's re-attach tail could no longer attribute the child's frames and its
  // no-progress budget elapsed against a healthy, still-advancing child. The fix
  // (`_rebindAgentToolChildRunRequestId`, called from `continueLastTurn` /
  // `_retryLastUserTurn`) keeps attribution alive across recovery. Deterministic
  // coverage of the rebind lives in
  // `packages/think/src/tests/agent-tool-reattach-recovery.test.ts`.
  it("does not abandon a still-progressing child as `interrupted` when the re-attach budget elapses after a deploy", async () => {
    wrangler = startWrangler();
    await waitForReady();

    // Kick the parent turn → runTask → child starts its long ledger loop.
    await sendChatMessage("seed the database");

    // Let a few child steps land so the deploy clearly interrupts a child
    // that is mid-flight (not before it starts, not after it finishes).
    await sleep(12_000);
    const beforeDeploy = await readStatus();
    console.log(
      `[reattach-budget] before deploy: child=${JSON.stringify(beforeDeploy?.child)}`
    );

    // ONE deploy (code-update reset), mirroring the production incident.
    console.log("[reattach-budget] deploying (SIGKILL + restart)...");
    wrangler = await restartWrangler(wrangler);

    // Poll until the parent settles the child run. On `main` it settles
    // `interrupted` at ~budget (120s) while the child is still advancing; with
    // the fix it stays non-terminal until the child genuinely completes.
    let status: TaskStatus | null = null;
    let interruptedChildMaxIndex = -1;
    const deadline = Date.now() + 270_000;
    while (Date.now() < deadline) {
      await sleep(3000);
      status = await readStatus();
      if (!status) continue;
      const pcs = status.parentChildStatus;
      console.log(
        `[reattach-budget] poll: parentChild=${pcs ?? "?"} childMax=${status.child?.maxIndex ?? "?"}/${CHILD_STEPS} childFibers=${status.child?.hasFiberRows ?? "?"} childRecov=${status.child?.recoveryCount ?? "?"} err=${status.parentChildError ?? ""}`
      );
      if (pcs === "interrupted") {
        // Capture the child's progress at the moment the parent gave up.
        interruptedChildMaxIndex = status.child?.maxIndex ?? -1;
        break;
      }
      if (pcs && TERMINAL_STATUSES.has(pcs)) break;
    }

    expect(status).not.toBeNull();
    const s = status as TaskStatus;

    const summary = {
      at: new Date().toISOString(),
      parentChildStatus: s.parentChildStatus,
      parentChildError: s.parentChildError,
      parentRecoveries: s.parentRecoveries,
      childMaxIndex: s.child?.maxIndex,
      childTotalSteps: CHILD_STEPS,
      childAtInterrupt: interruptedChildMaxIndex,
      childWasMidFlightAtInterrupt:
        interruptedChildMaxIndex >= 0 && interruptedChildMaxIndex < CHILD_STEPS
    };
    console.log(`[reattach-budget] FINAL: ${JSON.stringify(summary)}`);
    try {
      fs.appendFileSync(
        "/tmp/reattach-budget.log",
        `${JSON.stringify(summary)}\n`
      );
    } catch {
      // best-effort
    }

    // Diagnostic: if the parent abandoned the run, prove the child was still
    // mid-flight (healthy, advancing) — i.e. it was NOT a genuinely dead child.
    if (s.parentChildStatus === "interrupted") {
      expect(interruptedChildMaxIndex).toBeGreaterThan(0);
      expect(interruptedChildMaxIndex).toBeLessThan(CHILD_STEPS);
    }

    // The regression gate: a healthy child interrupted by a deploy must be
    // re-attached to its real terminal result, never abandoned `interrupted`.
    expect(s.parentChildStatus).toBe("completed");
  }, 330_000);
});
