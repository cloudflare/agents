/**
 * Think HITL bridge (Stage 4) — pause/approve/resume for the execute tool.
 *
 * A `needsApproval` AI SDK tool inside the sandbox pauses the run durably;
 * the paused output flows to the model as a normal tool result (the turn
 * ends, the model narrates). The built-in `approveExecution` /
 * `rejectExecution` callables resume/end the run, replace the paused output
 * in the transcript, and auto-continue the chat so the model sees the
 * outcome.
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

async function freshAgent(name: string) {
  return getAgentByName(env.ThinkExecuteHitlAgent, name);
}

async function connectWS(room: string) {
  const res = await exports.default.fetch(
    `http://example.com/agents/think-execute-hitl-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return ws;
}

function sendChatRequest(ws: WebSocket, text: string) {
  const id = crypto.randomUUID();
  const message: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }]
  };
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id,
      init: { method: "POST", body: JSON.stringify({ messages: [message] }) }
    })
  );
  return id;
}

function waitForDone(ws: WebSocket, timeout = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve();
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

/** Call a `@callable` over the WS RPC frame, resolving its result. */
function callRpc(
  ws: WebSocket,
  method: string,
  args: unknown[],
  timeout = 15000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for rpc ${method}`)),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type === "rpc" && msg.id === id) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          if (msg.success) resolve(msg.result);
          else reject(new Error(String(msg.error)));
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ type: "rpc", id, method, args }));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 50
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

type PausedOutput = {
  status: string;
  executionId: string;
  pending?: Array<{ connector: string; method: string; args?: unknown }>;
};

/** Run one chat turn that pauses, returning the paused execute output. */
async function runTurnToPause(room: string) {
  const agent = await freshAgent(room);
  const ws = await connectWS(room);
  sendChatRequest(ws, "deploy please");
  await waitForDone(ws);

  const parts = await agent.executeParts();
  expect(parts.length).toBeGreaterThanOrEqual(1);
  const paused = parts[0].output as PausedOutput;
  expect(parts[0].state).toBe("output-available");
  expect(paused.status).toBe("paused");
  expect(paused.executionId).toBeTruthy();

  // The model narrated the pause as a normal tool result.
  expect(await agent.lastAssistantText()).toContain("paused");
  // The gated tool did NOT run.
  expect(await agent.gatedCallCount()).toBe(0);

  return { agent, ws, executionId: paused.executionId };
}

describe("Think HITL — approve/reject paused executions", () => {
  it("pause → approve → output replaced → continuation sees the result", async () => {
    const room = crypto.randomUUID();
    const { agent, ws, executionId } = await runTurnToPause(room);

    const outcome = (await callRpc(ws, "approveExecution", [
      executionId
    ])) as PausedOutput;
    expect(outcome.status).toBe("completed");

    // The paused output was replaced in the transcript…
    await waitUntil(async () => {
      const parts = await agent.executeParts();
      return (parts[0].output as PausedOutput).status === "completed";
    });
    const parts = await agent.executeParts();
    const output = parts[0].output as { status: string; result?: unknown };
    expect(output.result).toBe("deployed:prod");

    // …the gated tool ran exactly once…
    expect(await agent.gatedCallCount()).toBe(1);

    // …and the auto-continuation showed the model the completed result.
    await waitUntil(async () =>
      (await agent.lastAssistantText()).includes("completed")
    );

    ws.close();
  });

  it("reject applies a rejected output with the reason and continues", async () => {
    const room = crypto.randomUUID();
    const { agent, ws, executionId } = await runTurnToPause(room);

    const outcome = (await callRpc(ws, "rejectExecution", [
      executionId,
      "too risky"
    ])) as { status: string; reason?: string };
    expect(outcome.status).toBe("rejected");
    expect(outcome.reason).toBe("too risky");

    await waitUntil(async () => {
      const parts = await agent.executeParts();
      return (parts[0].output as PausedOutput).status === "rejected";
    });
    const parts = await agent.executeParts();
    expect((parts[0].output as { reason?: string }).reason).toBe("too risky");

    // The gated tool never ran; the model adapted to the rejection.
    expect(await agent.gatedCallCount()).toBe(0);
    await waitUntil(async () =>
      (await agent.lastAssistantText()).includes("rejected")
    );

    ws.close();
  });

  it("pause-again: the next gated call re-pauses; a second approve completes", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    await agent.setExecuteCodes([
      `async () => {
        const a = await tools.deploy({ target: "staging" });
        const b = await tools.deploy({ target: "prod" });
        return [a, b].join("|");
      }`
    ]);
    const ws = await connectWS(room);
    sendChatRequest(ws, "deploy twice");
    await waitForDone(ws);

    const first = (await agent.executeParts())[0].output as PausedOutput;
    expect(first.status).toBe("paused");

    // First approve runs the first gated call, then pauses on the second.
    const second = (await callRpc(ws, "approveExecution", [
      first.executionId
    ])) as PausedOutput;
    expect(second.status).toBe("paused");
    expect(second.executionId).toBe(first.executionId);
    expect(await agent.gatedCallCount()).toBe(1);

    // The transcript shows the paused-again output (same executionId).
    await waitUntil(async () => {
      const parts = await agent.executeParts();
      const output = parts[0].output as PausedOutput;
      return (
        output.status === "paused" &&
        output.pending?.[0]?.args != null &&
        JSON.stringify(output.pending[0].args).includes("prod")
      );
    });

    // Second approve completes the run.
    const done = (await callRpc(ws, "approveExecution", [
      first.executionId
    ])) as { status: string; result?: unknown };
    expect(done.status).toBe("completed");
    expect(done.result).toBe("deployed:staging|deployed:prod");
    expect(await agent.gatedCallCount()).toBe(2);

    await waitUntil(async () =>
      (await agent.lastAssistantText()).includes("completed")
    );

    ws.close();
  });

  it("double-approve is graceful: the second returns an error and leaves the transcript alone", async () => {
    const room = crypto.randomUUID();
    const { agent, ws, executionId } = await runTurnToPause(room);

    const first = (await callRpc(ws, "approveExecution", [
      executionId
    ])) as PausedOutput;
    expect(first.status).toBe("completed");
    await waitUntil(async () => {
      const parts = await agent.executeParts();
      return (parts[0].output as PausedOutput).status === "completed";
    });

    const second = (await callRpc(ws, "approveExecution", [executionId])) as {
      status: string;
      error?: string;
    };
    expect(second.status).toBe("error");
    expect(second.error).toMatch(/not paused/);

    // First-write-wins: the completed output is untouched.
    const parts = await agent.executeParts();
    expect((parts[0].output as PausedOutput).status).toBe("completed");
    expect(await agent.gatedCallCount()).toBe(1);

    ws.close();
  });

  it("reject after approve is graceful: returns an error, never marks the run rejected", async () => {
    const room = crypto.randomUUID();
    const { agent, ws, executionId } = await runTurnToPause(room);

    const approved = (await callRpc(ws, "approveExecution", [
      executionId
    ])) as PausedOutput;
    expect(approved.status).toBe("completed");
    await waitUntil(async () => {
      const parts = await agent.executeParts();
      return (parts[0].output as PausedOutput).status === "completed";
    });

    // A stale reject (e.g. from a second tab) must not claim the run was
    // rejected — the gated action already executed.
    const rejected = (await callRpc(ws, "rejectExecution", [
      executionId,
      "changed my mind"
    ])) as { status: string; error?: string };
    expect(rejected.status).toBe("error");
    expect(rejected.error).toMatch(/no longer pending/);

    // The completed output is untouched.
    const parts = await agent.executeParts();
    expect((parts[0].output as PausedOutput).status).toBe("completed");
    expect(await agent.gatedCallCount()).toBe(1);

    ws.close();
  });

  it("approve after expiry returns a graceful error and reconciles the transcript", async () => {
    const room = crypto.randomUUID();
    const { agent, ws, executionId } = await runTurnToPause(room);

    const expired = await agent.expirePausedForTest();
    expect(expired).toContain(executionId);

    const outcome = (await callRpc(ws, "approveExecution", [executionId])) as {
      status: string;
      error?: string;
    };
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/not paused/);

    // The stale paused card resolves to the error outcome.
    await waitUntil(async () => {
      const parts = await agent.executeParts();
      return (parts[0].output as PausedOutput).status === "error";
    });
    expect(await agent.gatedCallCount()).toBe(0);

    ws.close();
  });

  it("an approval whose paused part was compacted away records a system note", async () => {
    const room = crypto.randomUUID();
    const { agent, ws, executionId } = await runTurnToPause(room);

    // Simulate compaction summarizing the paused tool part away.
    await agent.stripExecutePartsForTest();
    expect(await agent.executeParts()).toEqual([]);

    const outcome = (await callRpc(ws, "approveExecution", [
      executionId
    ])) as PausedOutput;
    expect(outcome.status).toBe("completed");
    // The runtime still applied the approval — the gated tool ran…
    expect(await agent.gatedCallCount()).toBe(1);

    // …and the outcome was not dropped: it landed as a system note.
    await waitUntil(async () =>
      (await agent.systemNoteTexts()).some(
        (text) => text.includes(executionId) && text.includes("completed")
      )
    );

    ws.close();
  });

  it("approveExecution works after the in-memory handle is lost (DO restart path)", async () => {
    const room = crypto.randomUUID();
    const { agent, ws, executionId } = await runTurnToPause(room);

    await agent.dropCodemodeHandleForTest();

    const outcome = (await callRpc(ws, "approveExecution", [
      executionId
    ])) as PausedOutput;
    expect(outcome.status).toBe("completed");
    expect(await agent.gatedCallCount()).toBe(1);

    ws.close();
  });

  it("supports concurrent paused executions — one approval card per part", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    await agent.setExecuteCodes([
      `async () => await tools.deploy({ target: "alpha" })`,
      `async () => await tools.deploy({ target: "beta" })`
    ]);
    const ws = await connectWS(room);
    sendChatRequest(ws, "deploy both");
    await waitForDone(ws);

    const parts = await agent.executeParts();
    expect(parts.length).toBe(2);
    const outputs = parts.map((p) => p.output as PausedOutput);
    expect(outputs.every((o) => o.status === "paused")).toBe(true);
    const [a, b] = outputs.map((o) => o.executionId);
    expect(a).not.toBe(b);

    // pendingExecutions sees both.
    const pending = (await callRpc(ws, "pendingExecutions", [])) as Array<{
      executionId: string;
    }>;
    expect(pending.map((p) => p.executionId).sort()).toEqual([a, b].sort());

    const first = (await callRpc(ws, "approveExecution", [a])) as PausedOutput;
    expect(first.status).toBe("completed");
    const second = (await callRpc(ws, "approveExecution", [b])) as PausedOutput;
    expect(second.status).toBe("completed");

    await waitUntil(async () => {
      const updated = await agent.executeParts();
      return updated.every(
        (p) => (p.output as PausedOutput).status === "completed"
      );
    });
    expect(await agent.gatedCallCount()).toBe(2);

    ws.close();
  });

  it("truncates pending args in the transcript while pendingExecutions returns full args", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const big = "x".repeat(5000);
    await agent.setExecuteCodes([
      `async () => await tools.deploy({ target: "${big}" })`
    ]);
    const ws = await connectWS(room);
    sendChatRequest(ws, "deploy big");
    await waitForDone(ws);

    const paused = (await agent.executeParts())[0].output as PausedOutput;
    expect(paused.status).toBe("paused");
    // Transcript copy is bounded.
    const transcriptArgs = JSON.stringify(paused.pending?.[0]?.args);
    expect(transcriptArgs).toContain("TRUNCATED");
    expect(transcriptArgs.length).toBeLessThan(4000);

    // The runtime keeps the full args — and the resume uses them.
    const pending = (await callRpc(ws, "pendingExecutions", [
      paused.executionId
    ])) as Array<{ args: { target: string } }>;
    expect(pending[0].args.target).toBe(big);

    const outcome = (await callRpc(ws, "approveExecution", [
      paused.executionId
    ])) as { status: string; result?: string };
    expect(outcome.status).toBe("completed");
    expect(outcome.result).toBe(`deployed:${big}`);

    ws.close();
  });
});
