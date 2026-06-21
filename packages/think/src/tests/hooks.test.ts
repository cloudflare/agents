import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_TOOL_APPROVAL = "cf_agent_tool_approval";

async function connectWS(agentClass: string, room: string) {
  const slug = agentClass
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
  const res = await exports.default.fetch(
    `http://example.com/agents/${slug}/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

function waitForDone(
  ws: WebSocket,
  timeout = 10000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for done")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        messages.push(msg);
        if (msg.type === MSG_CHAT_RESPONSE && msg.done === true) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // ignore non-JSON frames
      }
    };
    ws.addEventListener("message", handler);
  });
}

function closeWS(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.close();
  });
}

function sendChatRequest(ws: WebSocket, text: string) {
  const userMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }]
  };
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id: crypto.randomUUID(),
      init: {
        method: "POST",
        body: JSON.stringify({ messages: [userMessage] })
      }
    })
  );
}

function eventTypes(events: string[]): string[] {
  return events.map((event) => (JSON.parse(event) as { type: string }).type);
}

function websocketChunkTypes(
  messages: Array<Record<string, unknown>>
): string[] {
  return messages
    .filter((msg) => msg.type === MSG_CHAT_RESPONSE && msg.done === false)
    .map((msg) => JSON.parse(msg.body as string) as { type: string })
    .map((chunk) => chunk.type);
}

async function freshAgent(name: string) {
  return getAgentByName(env.ThinkTestAgent, name);
}

async function freshProgrammaticAgent(name: string) {
  return getAgentByName(env.ThinkProgrammaticTestAgent, name);
}

async function freshToolAgent(name: string) {
  return getAgentByName(env.ThinkToolsTestAgent, name);
}

async function freshLoopToolAgent(name: string) {
  return getAgentByName(env.LoopToolTestAgent, name);
}

// ── beforeTurn ──────────────────────────────────────────────────

describe("Think — beforeTurn hook", () => {
  it("receives correct TurnContext with system prompt and tools", async () => {
    const agent = await freshAgent("hook-bt-ctx");
    await agent.testChat("Hello");

    const log = await agent.getBeforeTurnLog();
    expect(log).toHaveLength(1);
    expect(log[0].system).toContain("You are a careful, capable assistant");
    expect(log[0].system).toContain("You are running inside a Think agent.");
    expect(log[0].system).toContain("agent workspace");
    expect(log[0].continuation).toBe(false);
    expect(log[0].toolNames).toContain("read");
    expect(log[0].toolNames).toContain("write");
  });

  it("fires on every turn", async () => {
    const agent = await freshAgent("hook-bt-multi");
    await agent.testChat("First");
    await agent.testChat("Second");

    const log = await agent.getBeforeTurnLog();
    expect(log).toHaveLength(2);
  });

  it("fires from chat() sub-agent path", async () => {
    const agent = await freshAgent("hook-bt-chat");
    await agent.testChat("Via chat()");

    const log = await agent.getBeforeTurnLog();
    expect(log).toHaveLength(1);
    expect(log[0].continuation).toBe(false);
  });

  it("captures continuation flag from programmatic path", async () => {
    const agent = await freshProgrammaticAgent("hook-bt-save");
    await agent.testChat("First message");
    const opts = await agent.getCapturedOptions();
    expect(opts).toHaveLength(1);
    expect(opts[0].continuation).toBe(false);
  });
});

// ── beforeStep ─────────────────────────────────────────────────

describe("Think — beforeStep hook", () => {
  it("receives the AI SDK prepareStep context before each step", async () => {
    const agent = await freshAgent("hook-bs-ctx");
    await agent.testChat("Hello");

    const log = await agent.getBeforeStepLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].stepNumber).toBe(0);
    expect(log[0].previousStepCount).toBe(0);
    expect(log[0].messageCount).toBeGreaterThan(0);
    expect(log[0].modelId).toBe("mock-model");
  });

  it("can override the model for a step", async () => {
    const agent = await freshAgent("hook-bs-model");
    await agent.setStepModelOverride("Overridden from beforeStep");
    await agent.testChat("Hello");

    const log = await agent.getStepLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].text).toBe("Overridden from beforeStep");
  });

  it("awaits async beforeStep hooks before continuing the step", async () => {
    // Regression for the Promise<StepConfig | void> return path. The
    // wrapper must `await` `this.beforeStep(event)` so a delayed override
    // still applies and the step waits on slow-to-resolve hooks.
    const agent = await freshAgent("hook-bs-async");
    await agent.setBeforeStepAsyncDelay(5);
    await agent.setStepModelOverride("Async override applied");
    await agent.testChat("Hello async");

    const log = await agent.getStepLog();
    expect(log[0].text).toBe("Async override applied");
  });

  it("fires once per step across a tool-call loop with growing previous-step state", async () => {
    // Regression: beforeStep must fire for every model step in the
    // agentic loop, and `ctx.steps` / `ctx.stepNumber` must reflect the
    // accumulating history. The tool-calling agent does step 0 (emits
    // tool-call), tool executes, then step 1 (emits final text).
    const agent = await freshToolAgent("hook-bs-multistep");
    await agent.testChat("Run a tool");

    const log = await agent.getBeforeStepLog();
    // Two model steps in the tool-call → answer flow.
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0].stepNumber).toBe(0);
    expect(log[0].previousStepCount).toBe(0);
    expect(log[0].previousToolResultCount).toBe(0);
    // After step 0 ran a tool, step 1's context sees one prior step
    // and one prior tool result.
    expect(log[1].stepNumber).toBe(1);
    expect(log[1].previousStepCount).toBe(1);
    expect(log[1].previousToolResultCount).toBe(1);
  });
});

// ── onStepFinish ────────────────────────────────────────────────

describe("Think — onStepFinish hook", () => {
  it("fires after step completes with correct data", async () => {
    const agent = await freshAgent("hook-sf-1");
    await agent.testChat("Hello");

    const log = await agent.getStepLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].finishReason).toBe("stop");
  });

  it("forwards the AI SDK's full StepResult — text and usage", async () => {
    // Regression for #1339 — ctx should expose the full AI SDK StepResult,
    // not a hand-picked subset. Verify text and the real usage fields make
    // it through (mock model emits "Hello from the assistant!" with
    // inputTokens=10, outputTokens=5).
    const agent = await freshAgent("hook-sf-shape");
    await agent.setResponse("Hello from the assistant!");
    await agent.testChat("Hello");

    const log = await agent.getStepLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].text).toBe("Hello from the assistant!");
    expect(log[0].inputTokens).toBe(10);
    expect(log[0].outputTokens).toBe(5);
  });

  it("forwards typed toolCalls/toolResults arrays", async () => {
    // The mock tool model emits one `echo` tool call and the loop
    // continues until the model produces final text. Verify both the
    // tool-call step and the final step are observed.
    const agent = await freshLoopToolAgent("hook-sf-tools");
    await agent.testChat("Use echo");

    const log = await agent.getStepLog();
    expect(log.length).toBeGreaterThanOrEqual(2);
    const toolStep = log.find((s) => s.toolCallCount > 0);
    expect(toolStep).toBeDefined();
    expect(toolStep!.toolResultCount).toBeGreaterThan(0);
  });
});

// ── beforeToolCall / afterToolCall ──────────────────────────────

describe("Think — tool-call hooks expose typed input/output", () => {
  it("beforeToolCall receives toolName and typed input", async () => {
    // Regression for #1339 — ctx.input was always {} because the wrapper
    // read tc.args (AI SDK uses .input). Verify the real input flows.
    const agent = await freshLoopToolAgent("hook-tc-input");
    await agent.testChat("Use echo");

    const log = await agent.getBeforeToolCallLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].toolName).toBe("echo");
    expect(JSON.parse(log[0].inputJson)).toEqual({ message: "ping" });
  });

  it("afterToolCall receives typed output (was always undefined before)", async () => {
    const agent = await freshLoopToolAgent("hook-tc-output");
    await agent.testChat("Use echo");

    const log = await agent.getAfterToolCallLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].toolName).toBe("echo");
    expect(JSON.parse(log[0].inputJson)).toEqual({ message: "ping" });
    // Mock tool returns "pong: ping"
    expect(JSON.parse(log[0].outputJson)).toBe("pong: ping");
  });
});

// ── Actions ──────────────────────────────────────────────────────

describe("Think — actions compile into guarded tools", () => {
  it("executes an action through the tool-call hooks", async () => {
    const agent = await freshToolAgent("action-default");
    await agent.useEchoActionForTest();
    await agent.testChat("call echo action");

    const before = await agent.getBeforeToolCallLog();
    expect(before.length).toBeGreaterThan(0);
    expect(before[0].toolName).toBe("echo");
    expect(JSON.parse(before[0].inputJson)).toEqual({ message: "hello" });

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(JSON.parse(after[0].outputJson)).toBe("action echo: hello");

    const probe = await agent.getActionProbe();
    expect(probe.count).toBe(1);
    expect(probe.context?.requestId).not.toBe("");
    expect(probe.context?.toolCallId).toBe("tc1");
    expect(probe.context?.messageCount).toBeGreaterThan(0);
  });

  it("allows permissioned actions by default", async () => {
    const agent = await freshToolAgent("action-permission-default");
    await agent.useEchoActionForTest("permission");
    await agent.testChat("call echo action");

    expect((await agent.getActionProbe()).count).toBe(1);
    const after = await agent.getAfterToolCallLog();
    expect(JSON.parse(after[0].outputJson)).toBe("action echo: hello");
  });

  it("denies permissioned actions before execute", async () => {
    const agent = await freshToolAgent("action-permission-denied");
    await agent.useEchoActionForTest("permission");
    await agent.setActionGrantedPermissions([]);
    await agent.testChat("call echo action");

    expect((await agent.getActionProbe()).count).toBe(0);
    const after = await agent.getAfterToolCallLog();
    expect(JSON.parse(after[0].outputJson)).toEqual({
      error: {
        name: "ActionAuthorizationError",
        message: "Missing required permission: echo:run",
        permissions: ["echo:run"]
      }
    });
  });

  it("maps thrown action errors to structured tool output", async () => {
    const agent = await freshToolAgent("action-throw");
    await agent.useEchoActionForTest("throw");
    await agent.testChat("call echo action");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(JSON.parse(after[0].outputJson)).toEqual({
      error: { name: "Error", message: "action failed" }
    });
  });

  it("times out actions with a structured tool output", async () => {
    const agent = await freshToolAgent("action-timeout");
    await agent.useEchoActionForTest("timeout");
    await agent.testChat("call echo action");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    const output = JSON.parse(after[0].outputJson) as {
      error?: { message?: string };
    };
    expect(output.error?.message).toContain("timed out");
  });

  it("truncates oversized action outputs before model consumption", async () => {
    const agent = await freshToolAgent("action-large-output");
    await agent.useEchoActionForTest("large-output");
    await agent.testChat("call echo action");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    const output = JSON.parse(after[0].outputJson) as string;
    expect(output).toContain("[truncated");
    expect(output.length).toBeLessThan(22_000);
  });

  it("normalizes non-JSON-safe action outputs before model consumption", async () => {
    const agent = await freshToolAgent("action-non-json-output");
    await agent.useEchoActionForTest("non-json-output");
    await agent.testChat("call echo action");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(JSON.parse(after[0].outputJson)).toEqual({
      count: "12n",
      self: "[Circular]"
    });
  });

  it("records and replays settled action ledger rows", async () => {
    const agent = await freshToolAgent(
      `action-ledger-replay-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("ledger-key");
    await agent.setActionIdempotencyKey("replay-key");

    await expect(agent.executeEchoActionToolForTest()).resolves.toBe(
      "action echo: hello"
    );
    expect((await agent.getActionProbe()).count).toBe(1);
    expect(await agent.listActionLedgerRowsForTest()).toMatchObject([
      {
        key: "action:echo:replay-key",
        action_name: "echo",
        status: "settled"
      }
    ]);

    await expect(agent.executeEchoActionToolForTest()).resolves.toBe(
      "action echo: hello"
    );
    expect((await agent.getActionProbe()).count).toBe(1);
  });

  it("returns a programming error for action ledger key/input conflicts", async () => {
    const agent = await freshToolAgent(
      `action-ledger-conflict-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("ledger-key");
    await agent.setActionIdempotencyKey("conflict-key");

    await expect(agent.executeEchoActionToolForTest()).resolves.toBe(
      "action echo: hello"
    );
    await expect(
      agent.executeEchoActionToolForTest("different")
    ).resolves.toEqual({
      error: {
        name: "ActionKeyConflict",
        message:
          'Idempotency key "action:echo:conflict-key" for action "echo" was reused with different input. This is a programming error; do not retry.'
      }
    });

    expect((await agent.getActionProbe()).count).toBe(1);
  });

  it("does not execute when the action ledger has an unknown pending row", async () => {
    const agent = await freshToolAgent(
      `action-ledger-pending-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("ledger-key");
    await agent.setActionIdempotencyKey("pending-key");
    await agent.insertActionLedgerRowForTest({
      key: "action:echo:pending-key",
      status: "pending"
    });

    await agent.testChat("call echo action");

    expect((await agent.getActionProbe()).count).toBe(0);
    const after = await agent.getAfterToolCallLog();
    expect(JSON.parse(after[after.length - 1]?.outputJson ?? "null")).toEqual({
      error: {
        name: "ActionPendingError",
        message:
          "A prior attempt of this action is in an unknown state; not re-executed. Manual reconciliation may be required."
      }
    });
  });

  it("reclaims a stale explicit-key pending row and settles it", async () => {
    const agent = await freshToolAgent(
      `action-ledger-reclaim-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("ledger-key");
    await agent.setActionIdempotencyKey("pending-key");
    await agent.setActionLedgerPendingRetryLeaseForTest(50);
    const stale = Date.now() - 1_000;
    await agent.insertActionLedgerRowForTest({
      key: "action:echo:pending-key",
      status: "pending",
      updatedAt: stale
    });

    await expect(agent.executeEchoActionToolForTest()).resolves.toBe(
      "action echo: hello"
    );

    expect((await agent.getActionProbe()).count).toBe(1);
    const rows = await agent.listActionLedgerRowsForTest();
    expect(rows).toMatchObject([
      { key: "action:echo:pending-key", status: "settled" }
    ]);
    // Reclaim refreshes the lease timestamp before settling.
    expect(rows[0]!.updated_at).toBeGreaterThan(stale);
  });

  it("does not reclaim a stale fallback-key pending row", async () => {
    const agent = await freshToolAgent(
      `action-ledger-fallback-${crypto.randomUUID()}`
    );
    // "default" mode declares no idempotencyKey, so the ledger key falls back
    // to `tool:${toolCallId}` — never eligible for stale reclaim.
    await agent.useEchoActionForTest("default");
    await agent.setActionLedgerPendingRetryLeaseForTest(50);
    await agent.insertActionLedgerRowForTest({
      key: "tool:tc-direct",
      status: "pending",
      updatedAt: Date.now() - 1_000
    });

    await expect(agent.executeEchoActionToolForTest()).resolves.toEqual({
      error: {
        name: "ActionPendingError",
        message:
          "A prior attempt of this action is in an unknown state; not re-executed. Manual reconciliation may be required."
      }
    });
    expect((await agent.getActionProbe()).count).toBe(0);
  });

  it("does not reclaim a stale explicit pending row when the lease is disabled", async () => {
    const agent = await freshToolAgent(
      `action-ledger-lease-off-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("ledger-key");
    await agent.setActionIdempotencyKey("pending-key");
    await agent.setActionLedgerPendingRetryLeaseForTest(false);
    await agent.insertActionLedgerRowForTest({
      key: "action:echo:pending-key",
      status: "pending",
      updatedAt: Date.now() - 1_000
    });

    await expect(agent.executeEchoActionToolForTest()).resolves.toEqual({
      error: {
        name: "ActionPendingError",
        message:
          "A prior attempt of this action is in an unknown state; not re-executed. Manual reconciliation may be required."
      }
    });
    expect((await agent.getActionProbe()).count).toBe(0);
  });

  it("releases the row when a reclaimed execution throws", async () => {
    const agent = await freshToolAgent(
      `action-ledger-reclaim-throw-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("ledger-throw");
    await agent.setActionIdempotencyKey("throw-key");
    await agent.setActionLedgerPendingRetryLeaseForTest(50);
    await agent.insertActionLedgerRowForTest({
      key: "action:echo:throw-key",
      status: "pending",
      updatedAt: Date.now() - 1_000
    });

    await expect(agent.executeEchoActionToolForTest()).resolves.toEqual({
      error: { name: "Error", message: "ledger action failed" }
    });
    expect((await agent.getActionProbe()).count).toBe(1);
    expect(await agent.listActionLedgerRowsForTest()).toEqual([]);

    // The released row lets a later attempt run again.
    await expect(agent.executeEchoActionToolForTest()).resolves.toEqual({
      error: { name: "Error", message: "ledger action failed" }
    });
    expect((await agent.getActionProbe()).count).toBe(2);
    expect(await agent.listActionLedgerRowsForTest()).toEqual([]);
  });

  it("executes once when a stale reclaim races itself in one isolate", async () => {
    const agent = await freshToolAgent(
      `action-ledger-reclaim-coalesce-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("ledger-slow");
    await agent.setActionIdempotencyKey("coalesce-key");
    await agent.setActionDelayForTest(50);
    await agent.setActionLedgerPendingRetryLeaseForTest(50);
    await agent.insertActionLedgerRowForTest({
      key: "action:echo:coalesce-key",
      status: "pending",
      updatedAt: Date.now() - 1_000
    });

    await expect(agent.executeEchoActionToolParallelForTest()).resolves.toEqual(
      ["action echo: hello", "action echo: hello"]
    );

    expect((await agent.getActionProbe()).count).toBe(1);
    expect(await agent.listActionLedgerRowsForTest()).toMatchObject([
      { key: "action:echo:coalesce-key", status: "settled" }
    ]);
  });

  it("releases action ledger keys after execution failure", async () => {
    const agent = await freshToolAgent(
      `action-ledger-release-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("ledger-throw");
    await agent.setActionIdempotencyKey("throw-key");

    await expect(agent.executeEchoActionToolForTest()).resolves.toEqual({
      error: { name: "Error", message: "ledger action failed" }
    });
    await expect(agent.executeEchoActionToolForTest()).resolves.toEqual({
      error: { name: "Error", message: "ledger action failed" }
    });

    expect((await agent.getActionProbe()).count).toBe(2);
    expect(await agent.listActionLedgerRowsForTest()).toEqual([]);
  });

  it("coalesces same-isolate duplicate action ledger executions", async () => {
    const agent = await freshToolAgent(
      `action-ledger-coalesce-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("ledger-slow");
    await agent.setActionIdempotencyKey("coalesce-key");
    await agent.setActionDelayForTest(50);

    await expect(agent.executeEchoActionToolParallelForTest()).resolves.toEqual(
      ["action echo: hello", "action echo: hello"]
    );

    expect((await agent.getActionProbe()).count).toBe(1);
    expect(await agent.listActionLedgerRowsForTest()).toMatchObject([
      {
        key: "action:echo:coalesce-key",
        status: "settled"
      }
    ]);
  });

  it("releases action ledger rows when result serialization fails", async () => {
    const agent = await freshToolAgent(
      `action-ledger-serialize-failure-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("ledger-symbol-output");
    await agent.setActionIdempotencyKey("symbol-key");

    const output = await agent.executeEchoActionToolForTest();

    expect(output).toEqual({ type: "symbol" });
    expect((await agent.getActionProbe()).count).toBe(1);
    expect(await agent.listActionLedgerRowsForTest()).toEqual([]);
  });

  it("sweeps expired action ledger rows without deleting fresh rows", async () => {
    const agent = await freshToolAgent(
      `action-ledger-sweep-${crypto.randomUUID()}`
    );
    await agent.useEchoActionForTest("ledger-key");
    await agent.setActionLedgerRetentionForTest({
      settledMs: 10,
      pendingMs: 10,
      maxSweepRows: 10
    });
    const old = Date.now() - 1_000;
    await agent.insertActionLedgerRowForTest({
      key: "action:echo:old-settled",
      status: "settled",
      output: "old",
      updatedAt: old
    });
    await agent.insertActionLedgerRowForTest({
      key: "action:echo:old-pending",
      status: "pending",
      updatedAt: old
    });
    await agent.insertActionLedgerRowForTest({
      key: "action:echo:fresh-settled",
      status: "settled",
      output: "fresh"
    });

    await expect(agent.sweepActionLedgerForTest()).resolves.toEqual({
      settled: 1,
      pending: 1
    });

    expect(await agent.listActionLedgerRowsForTest()).toMatchObject([
      {
        key: "action:echo:fresh-settled",
        status: "settled"
      }
    ]);
  });

  it("emits an approval request with a stable action descriptor", async () => {
    const room = `action-approval-request-${crypto.randomUUID()}`;
    const agent = await freshToolAgent(room);
    await agent.useEchoActionForTest("approval-permission");
    await agent.setActionGrantedPermissions(["echo:run"]);
    const ws = await connectWS("ThinkToolsTestAgent", room);

    const initialDone = waitForDone(ws);
    sendChatRequest(ws, "call echo action");
    const initialFrames = await initialDone;
    const approvalChunk = initialFrames
      .filter(
        (frame) =>
          frame.type === MSG_CHAT_RESPONSE &&
          typeof frame.body === "string" &&
          frame.body.length > 0
      )
      .map(
        (frame) => JSON.parse(frame.body as string) as Record<string, unknown>
      )
      .find((chunk) => chunk.type === "tool-approval-request");

    expect(approvalChunk).toMatchObject({
      toolCallId: "tc1",
      approvalDescriptor: {
        requestId: expect.any(String),
        toolCallId: "tc1",
        action: "echo",
        summary: "Approve echo action",
        input: { message: "hello" },
        permissions: ["echo:run"],
        risk: "low",
        kind: "approval-gated"
      }
    });

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const toolPart = messages
      .flatMap((message) => message.parts)
      .find((part) => "toolCallId" in part && part.toolCallId === "tc1") as
      | Record<string, unknown>
      | undefined;
    expect(toolPart).toMatchObject({
      state: "approval-requested",
      approval: {
        descriptor: {
          action: "echo",
          summary: "Approve echo action",
          input: { message: "hello" }
        }
      }
    });

    await closeWS(ws);
  });

  it("supports function-valued approval and permission policies", async () => {
    const room = `action-function-policy-${crypto.randomUUID()}`;
    const agent = await freshToolAgent(room);
    await agent.useEchoActionForTest("function-policy");
    await agent.setActionGrantedPermissions(["echo:hello"]);
    const ws = await connectWS("ThinkToolsTestAgent", room);

    const initialDone = waitForDone(ws);
    sendChatRequest(ws, "call echo action");
    const initialFrames = await initialDone;
    const approvalChunk = initialFrames
      .filter(
        (frame) =>
          frame.type === MSG_CHAT_RESPONSE &&
          typeof frame.body === "string" &&
          frame.body.length > 0
      )
      .map(
        (frame) => JSON.parse(frame.body as string) as Record<string, unknown>
      )
      .find((chunk) => chunk.type === "tool-approval-request");

    expect(approvalChunk).toMatchObject({
      toolCallId: "tc1",
      approvalDescriptor: {
        action: "echo",
        input: { message: "hello" },
        permissions: ["echo:hello"]
      }
    });

    await closeWS(ws);
  });

  it("denies approval-gated actions before prompting", async () => {
    const room = `action-approval-denied-before-prompt-${crypto.randomUUID()}`;
    const agent = await freshToolAgent(room);
    await agent.useEchoActionForTest("approval-permission");
    await agent.setActionGrantedPermissions([]);
    const ws = await connectWS("ThinkToolsTestAgent", room);

    const initialDone = waitForDone(ws);
    sendChatRequest(ws, "call echo action");
    const initialFrames = await initialDone;
    const chunks = initialFrames
      .filter(
        (frame) =>
          frame.type === MSG_CHAT_RESPONSE &&
          typeof frame.body === "string" &&
          frame.body.length > 0
      )
      .map(
        (frame) => JSON.parse(frame.body as string) as Record<string, unknown>
      );
    expect(chunks.some((chunk) => chunk.type === "tool-approval-request")).toBe(
      false
    );
    expect((await agent.getActionProbe()).count).toBe(0);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const toolPart = messages
      .flatMap((message) => message.parts)
      .find((part) => "toolCallId" in part && part.toolCallId === "tc1") as
      | Record<string, unknown>
      | undefined;
    expect(toolPart).toMatchObject({
      state: "output-available",
      output: {
        error: {
          name: "ActionAuthorizationError",
          message: "Missing required permission: echo:run",
          permissions: ["echo:run"]
        }
      }
    });
    expect(await agent.listActionLedgerRowsForTest()).toEqual([]);

    await closeWS(ws);
  });

  it("rechecks authorization after approval before execute", async () => {
    const room = `action-approval-grant-changed-${crypto.randomUUID()}`;
    const agent = await freshToolAgent(room);
    await agent.useEchoActionForTest("approval-permission");
    await agent.setActionGrantedPermissions(["echo:run"]);
    const ws = await connectWS("ThinkToolsTestAgent", room);

    const initialDone = waitForDone(ws);
    sendChatRequest(ws, "call echo action");
    await initialDone;

    await agent.setActionGrantedPermissions([]);

    const continuationDone = waitForDone(ws);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc1",
        approved: true,
        autoContinue: true
      })
    );
    await continuationDone;

    expect((await agent.getActionProbe()).count).toBe(0);
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const toolPart = messages
      .flatMap((message) => message.parts)
      .find((part) => "toolCallId" in part && part.toolCallId === "tc1") as
      | Record<string, unknown>
      | undefined;
    expect(toolPart).toMatchObject({
      state: "output-available",
      output: {
        error: {
          name: "ActionAuthorizationError",
          message: "Missing required permission: echo:run",
          permissions: ["echo:run"]
        }
      }
    });

    await closeWS(ws);
  });

  it("resumes and executes an approved action", async () => {
    const room = `action-approval-approved-${crypto.randomUUID()}`;
    const agent = await freshToolAgent(room);
    await agent.useEchoActionForTest("approval");
    const ws = await connectWS("ThinkToolsTestAgent", room);

    const initialDone = waitForDone(ws);
    sendChatRequest(ws, "call echo action");
    await initialDone;

    const continuationDone = waitForDone(ws);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc1",
        approved: true,
        autoContinue: true
      })
    );
    await continuationDone;

    expect((await agent.getActionProbe()).count).toBe(1);
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const toolPart = messages
      .flatMap((message) => message.parts)
      .find((part) => "toolCallId" in part && part.toolCallId === "tc1") as
      | Record<string, unknown>
      | undefined;
    expect(toolPart).toMatchObject({
      state: "output-available",
      output: "action echo: hello",
      approval: {
        approved: true,
        descriptor: {
          action: "echo"
        }
      }
    });

    await closeWS(ws);
  });

  it("records approval-gated actions only after approval", async () => {
    const room = `action-ledger-approval-${crypto.randomUUID()}`;
    const agent = await freshToolAgent(room);
    await agent.useEchoActionForTest("ledger-approval");
    await agent.setActionIdempotencyKey("approval-ledger-key");
    const ws = await connectWS("ThinkToolsTestAgent", room);

    const initialDone = waitForDone(ws);
    sendChatRequest(ws, "call echo action");
    await initialDone;
    expect(await agent.listActionLedgerRowsForTest()).toEqual([]);

    const continuationDone = waitForDone(ws);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc1",
        approved: true,
        autoContinue: true
      })
    );
    await continuationDone;

    expect((await agent.getActionProbe()).count).toBe(1);
    expect(await agent.listActionLedgerRowsForTest()).toMatchObject([
      {
        key: "action:echo:approval-ledger-key",
        status: "settled"
      }
    ]);

    await closeWS(ws);
  });

  it("does not execute an approved action with rewritten input", async () => {
    const room = `action-approval-rewritten-input-${crypto.randomUUID()}`;
    const agent = await freshToolAgent(room);
    await agent.useEchoActionForTest("approval");
    const ws = await connectWS("ThinkToolsTestAgent", room);

    const initialDone = waitForDone(ws);
    sendChatRequest(ws, "call echo action");
    await initialDone;

    await agent.setToolCallDecision({
      action: "allow",
      input: { message: "rewritten" }
    });

    const continuationDone = waitForDone(ws);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc1",
        approved: true,
        autoContinue: true
      })
    );
    await continuationDone;

    expect((await agent.getActionProbe()).count).toBe(0);
    const after = await agent.getAfterToolCallLog();
    expect(JSON.parse(after[0].outputJson)).toEqual({
      error: {
        name: "ActionApprovalInputError",
        message: "Approved action input cannot be changed by beforeToolCall"
      }
    });

    await closeWS(ws);
  });

  it("does not execute a rejected action", async () => {
    const room = `action-approval-rejected-${crypto.randomUUID()}`;
    const agent = await freshToolAgent(room);
    await agent.useEchoActionForTest("approval");
    const ws = await connectWS("ThinkToolsTestAgent", room);

    const initialDone = waitForDone(ws);
    sendChatRequest(ws, "call echo action");
    await initialDone;

    const continuationDone = waitForDone(ws);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc1",
        approved: false,
        autoContinue: true
      })
    );
    await continuationDone;

    expect((await agent.getActionProbe()).count).toBe(0);
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const toolPart = messages
      .flatMap((message) => message.parts)
      .find((part) => "toolCallId" in part && part.toolCallId === "tc1") as
      | Record<string, unknown>
      | undefined;
    expect(toolPart).toMatchObject({
      state: "output-denied",
      approval: {
        approved: false,
        descriptor: {
          action: "echo"
        }
      }
    });
    expect(await agent.listActionLedgerRowsForTest()).toEqual([]);

    await closeWS(ws);
  });

  it("keeps beforeToolCall as the outer gate after approval", async () => {
    const room = `action-approval-before-tool-call-${crypto.randomUUID()}`;
    const agent = await freshToolAgent(room);
    await agent.useEchoActionForTest("approval");
    await agent.setToolCallDecision({
      action: "block",
      reason: "blocked by hook"
    });
    const ws = await connectWS("ThinkToolsTestAgent", room);

    const initialDone = waitForDone(ws);
    sendChatRequest(ws, "call echo action");
    await initialDone;

    const continuationDone = waitForDone(ws);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc1",
        approved: true,
        autoContinue: true
      })
    );
    await continuationDone;

    expect((await agent.getActionProbe()).count).toBe(0);
    const after = await agent.getAfterToolCallLog();
    expect(JSON.parse(after[0].outputJson)).toBe("blocked by hook");

    await closeWS(ws);
  });
});

// ── ToolCallDecision (block / substitute / allow-with-input) ────

describe("Think — ToolCallDecision honored by wrapped execute", () => {
  it("void decision runs the original execute with original input", async () => {
    const agent = await freshToolAgent("dec-default");
    await agent.setToolCallDecision(null);
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].toolName).toBe("echo");
    expect(JSON.parse(after[0].inputJson)).toEqual({ message: "hello" });
    // Real tool returned "echo: hello"
    expect(JSON.parse(after[0].outputJson)).toBe("echo: hello");
  });

  it("'allow' with modified input runs execute with the substituted input", async () => {
    const agent = await freshToolAgent("dec-allow-input");
    await agent.setToolCallDecision({
      action: "allow",
      input: { message: "rewritten" }
    });
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    // `afterToolCall.input` reflects what the *model* emitted (the
    // AI SDK records the original tool-call chunk), while `output`
    // reflects the result of executing with the substituted input.
    expect(JSON.parse(after[0].inputJson)).toEqual({ message: "hello" });
    expect(JSON.parse(after[0].outputJson)).toBe("echo: rewritten");
  });

  it("'block' short-circuits execute and returns reason as the result", async () => {
    const agent = await freshToolAgent("dec-block");
    await agent.setToolCallDecision({
      action: "block",
      reason: "not allowed in this context"
    });
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    // afterToolCall fires with success=true (block is a successful
    // outcome from the model's perspective — it gets a string back)
    // and the reason as output.
    expect(JSON.parse(after[0].outputJson)).toBe("not allowed in this context");
  });

  it("'block' with no reason returns a default string", async () => {
    const agent = await freshToolAgent("dec-block-default");
    await agent.setToolCallDecision({ action: "block" });
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(JSON.parse(after[0].outputJson)).toContain("blocked");
  });

  it("'substitute' short-circuits execute and returns the substituted output", async () => {
    const agent = await freshToolAgent("dec-substitute");
    await agent.setToolCallDecision({
      action: "substitute",
      output: { fake: "value", reason: "cached" }
    });
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(JSON.parse(after[0].outputJson)).toEqual({
      fake: "value",
      reason: "cached"
    });
  });

  it("async beforeToolCall (Promise<ToolCallDecision>) is awaited correctly", async () => {
    // Verify the wrapper's `await this.beforeToolCall(ctx)` actually
    // waits for an async hook to resolve before deciding what to do.
    const agent = await freshToolAgent("dec-async");
    await agent.setBeforeToolCallAsync(true);
    await agent.setToolCallDecision({
      action: "substitute",
      output: "from async hook"
    });
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(JSON.parse(after[0].outputJson)).toBe("from async hook");
  });

  it("a throwing beforeToolCall surfaces as a tool error in afterToolCall", async () => {
    // A subclass that throws from `beforeToolCall` should be observably
    // equivalent to `execute` throwing — i.e. the AI SDK catches it and
    // emits a tool-error, which `afterToolCall` sees as `success: false`.
    const agent = await freshToolAgent("dec-throw");
    await agent.setBeforeToolCallThrows("policy violation");
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    const parsed = JSON.parse(after[0].outputJson) as { error: string };
    expect(parsed.error).toContain("policy violation");
  });

  it("collapses Promise<AsyncIterable> returns to the last yielded value", async () => {
    // Regression: the wrapper used to call `originalExecute(...)` without
    // awaiting it, then check `Symbol.asyncIterator in result`. For an
    // `async function execute(...) { return makeIter(); }` the result is
    // `Promise<AsyncIterable>`, the symbol check is always false, and
    // the AI SDK ends up treating the iterator instance itself as the
    // final output value (broken). The fix awaits before inspecting.
    const agent = await freshToolAgent("dec-async-iterable");
    await agent.setEchoExecuteMode("async-iterable");
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].toolName).toBe("echo");
    // The mock yields three values; we should see the last one as the
    // collapsed final output, NOT the AsyncGenerator instance.
    expect(JSON.parse(after[0].outputJson)).toBe("echo: hello");
  });

  it("collapses sync AsyncIterable returns to the last yielded value", async () => {
    // The sync-function-returning-AsyncIterable case worked before the
    // fix too, since the result wasn't a Promise. Belt-and-suspenders
    // coverage so future refactors don't regress it.
    const agent = await freshToolAgent("dec-sync-iterable");
    await agent.setEchoExecuteMode("sync-iterable");
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(JSON.parse(after[0].outputJson)).toBe("echo: hello");
  });

  it("addMessages from inside a tool execute runs mid-turn and persists", async () => {
    // Validates the premise the mid-turn broadcast gate relies on: a real tool
    // `execute` runs with `_insideInferenceLoop === true`, so `addMessages`
    // suppresses its broadcast there. Also confirms the write is durable the
    // moment it returns (not deferred to the next turn).
    const agent = await freshToolAgent("dec-add-messages");
    await agent.setEchoExecuteMode("add-messages");
    await agent.testChat("call echo");

    const probe = await agent.getMidTurnAddProbe();
    expect(probe.insideLoop).toBe(true);
    expect(probe.persisted).toBe(true);
  });
});

// ── Extension hook dispatch ─────────────────────────────────────

async function freshExtensionHookAgent(name: string) {
  return getAgentByName(env.ThinkExtensionHookAgent, name);
}

describe("Think — extension observation hooks", () => {
  it("dispatches beforeToolCall to extension subscribers", async () => {
    // Regression for the gap where ExtensionManifest.hooks accepted
    // beforeToolCall/afterToolCall/onStepFinish/onChunk but Think only
    // ever fired beforeTurn. The extension records each hook into a
    // workspace marker file via the host bridge.
    const agent = await freshExtensionHookAgent(
      `ext-before-tc-${crypto.randomUUID()}`
    );
    await agent.testChat("ping");

    const files = await agent.listExtLogFiles();
    expect(files).toContain("before-ping.json");

    const recorded = (await agent.readExtLogFile("before-ping.json")) as {
      toolName: string;
      input: unknown;
      stepNumber: number;
    } | null;
    expect(recorded).not.toBeNull();
    expect(recorded!.toolName).toBe("ping");
    expect(recorded!.input).toEqual({ msg: "hi" });
  });

  it("dispatches afterToolCall with success/output and durationMs", async () => {
    const agent = await freshExtensionHookAgent("ext-after-tc");
    await agent.testChat("ping");

    const recorded = (await agent.readExtLogFile("after-ping.json")) as {
      toolName: string;
      success: boolean;
      output: unknown;
      durationMs: number;
    } | null;
    expect(recorded).not.toBeNull();
    expect(recorded!.toolName).toBe("ping");
    expect(recorded!.success).toBe(true);
    expect(recorded!.output).toBe("pong: hi");
    expect(typeof recorded!.durationMs).toBe("number");
  });

  it("dispatches onStepFinish to extension subscribers", async () => {
    const agent = await freshExtensionHookAgent("ext-step-finish");
    await agent.testChat("ping");

    // Two steps: one with the tool call, one with the final text.
    const files = await agent.listExtLogFiles();
    const stepFiles = files.filter((f) => f.startsWith("step-"));
    expect(stepFiles.length).toBeGreaterThanOrEqual(1);

    const first = (await agent.readExtLogFile(stepFiles[0])) as {
      stepNumber: number;
      finishReason: string;
      usage: { inputTokens?: number; outputTokens?: number };
    } | null;
    expect(first).not.toBeNull();
    expect(typeof first!.stepNumber).toBe("number");
    expect(typeof first!.finishReason).toBe("string");
  });

  it("dispatches onChunk to extension subscribers", async () => {
    const agent = await freshExtensionHookAgent("ext-on-chunk");
    await agent.testChat("ping");

    const files = await agent.listExtLogFiles();
    const chunkFiles = files.filter((f) => f.startsWith("chunk-"));
    expect(chunkFiles.length).toBeGreaterThan(0);

    // We expect at least a text-delta chunk from the final-step text.
    const recorded = (await agent.readExtLogFile("chunk-text-delta.json")) as {
      type: string;
      text?: string;
    } | null;
    expect(recorded).not.toBeNull();
    expect(recorded!.type).toBe("text-delta");
  });
});

// ── onChunk ─────────────────────────────────────────────────────

describe("Think — onChunk hook", () => {
  it("fires for streaming chunks", async () => {
    const agent = await freshAgent("hook-chunk-1");
    await agent.testChat("Hello");

    const count = await agent.getChunkCount();
    expect(count).toBeGreaterThan(0);
  });
});

// ── maxSteps property ───────────────────────────────────────────

describe("Think — maxSteps property", () => {
  it("respects maxSteps override on class", async () => {
    const agent = await freshToolAgent("hook-maxsteps");
    const result = await agent.testChat("Test");
    expect(result.done).toBe(true);
  });

  it("composes TurnConfig stopWhen with the maxSteps bound", async () => {
    const agent = await freshToolAgent("hook-stop-when-tool-call");
    await agent.stopAfterEchoToolCall();
    const result = await agent.testChat("Call echo");

    expect(result.done).toBe(true);
    expect(await agent.getBeforeStepLog()).toHaveLength(1);
    expect(await agent.getAfterToolCallLog()).toHaveLength(1);
  });

  it("works with tool-calling loop agent", async () => {
    const agent = await freshLoopToolAgent("hook-loop-ms");
    const messages = agent.getMessages();
    expect(messages).toBeDefined();
  });
});

// ── Convergence: hooks fire from all entry paths ────────────────

describe("Think — hook convergence", () => {
  it("beforeTurn fires from chat() RPC path", async () => {
    const agent = await freshAgent("hook-conv-chat");
    await agent.testChat("From chat");

    const log = await agent.getBeforeTurnLog();
    expect(log).toHaveLength(1);
  });

  it("beforeTurn fires from saveMessages path", async () => {
    const agent = await freshProgrammaticAgent("hook-conv-save");
    await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "From saveMessages" }]
      }
    ]);

    const opts = await agent.getCapturedOptions();
    expect(opts).toHaveLength(1);
  });
});

// ── Dynamic context (Phase 2) ───────────────────────────────────

async function freshSessionAgent(name: string) {
  return getAgentByName(env.ThinkSessionTestAgent, name);
}

describe("Think — dynamic context", () => {
  it("addContext registers a new block", async () => {
    const agent = await freshSessionAgent("dctx-add");
    await agent.addDynamicContext("notes", "User notes");

    const labels = await agent.getContextLabels();
    expect(labels).toContain("memory");
    expect(labels).toContain("notes");
  });

  it("addContext block appears in system prompt after refresh", async () => {
    const agent = await freshSessionAgent("dctx-prompt");
    await agent.addDynamicContext("extra", "Extra context block");
    await agent.setContextBlock("extra", "Some important content");
    const prompt = await agent.refreshPrompt();

    expect(prompt).toContain("EXTRA");
    expect(prompt).toContain("Some important content");
  });

  it("removeContext removes the block", async () => {
    const agent = await freshSessionAgent("dctx-remove");
    await agent.addDynamicContext("temp", "Temporary block");

    let labels = await agent.getContextLabels();
    expect(labels).toContain("temp");

    const removed = await agent.removeDynamicContext("temp");
    expect(removed).toBe(true);

    labels = await agent.getContextLabels();
    expect(labels).not.toContain("temp");
  });

  it("removeContext returns false for non-existent block", async () => {
    const agent = await freshSessionAgent("dctx-remove-none");
    const removed = await agent.removeDynamicContext("nonexistent");
    expect(removed).toBe(false);
  });

  it("removed block disappears from system prompt after refresh", async () => {
    const agent = await freshSessionAgent("dctx-remove-prompt");
    await agent.addDynamicContext("ephemeral", "Gone soon");
    await agent.setContextBlock("ephemeral", "Temporary data");
    await agent.refreshPrompt();

    let prompt = await agent.getSystemPromptSnapshot();
    expect(prompt).toContain("EPHEMERAL");

    await agent.removeDynamicContext("ephemeral");
    prompt = await agent.refreshPrompt();
    expect(prompt).not.toContain("EPHEMERAL");
  });

  it("dynamic block is writable by default", async () => {
    const agent = await freshSessionAgent("dctx-writable");
    await agent.addDynamicContext("writable_block");

    const details = await agent.getContextBlockDetails("writable_block");
    expect(details).toBeDefined();
    expect(details!.writable).toBe(true);
  });

  it("dynamic block content can be written via setContextBlock", async () => {
    const agent = await freshSessionAgent("dctx-write");
    await agent.addDynamicContext("data", "Stored data");
    await agent.setContextBlock("data", "Hello world");

    const content = await agent.getContextBlockContent("data");
    expect(content).toBe("Hello world");
  });

  it("session tools include set_context after adding writable block", async () => {
    const agent = await freshSessionAgent("dctx-tools");
    await agent.addDynamicContext("notes", "Notes block");

    const toolNames = await agent.getSessionToolNames();
    expect(toolNames).toContain("set_context");
  });

  it("addContext coexists with configureSession blocks", async () => {
    const agent = await freshSessionAgent("dctx-coexist");
    await agent.addDynamicContext("extra", "Extra block");
    await agent.setContextBlock("extra", "Extra content");
    await agent.setContextBlock("memory", "Memory content");
    const prompt = await agent.refreshPrompt();

    expect(prompt).toContain("MEMORY");
    expect(prompt).toContain("EXTRA");
    expect(prompt).toContain("Extra content");
    expect(prompt).toContain("Memory content");
  });

  it("dynamic block visible in chat turn tools", async () => {
    const agent = await freshAgent("dctx-turn");
    await agent.testChat("First turn");

    const log = await agent.getBeforeTurnLog();
    const tools = log[0].toolNames;

    expect(tools).not.toContain("set_context");
  });
});

// ── Host bridge methods (Phase 3) ───────────────────────────────

describe("Think — host bridge methods", () => {
  it("_hostWriteFile and _hostReadFile delegate to workspace", async () => {
    const agent = await freshAgent("host-ws-rw");
    await agent.hostWriteFile("test.txt", "hello world");
    const content = await agent.hostReadFile("test.txt");
    expect(content).toBe("hello world");
  });

  it("_hostReadFile returns null for missing file", async () => {
    const agent = await freshAgent("host-ws-miss");
    const content = await agent.hostReadFile("nonexistent.txt");
    expect(content).toBeNull();
  });

  it("_hostGetMessages returns conversation history", async () => {
    const agent = await freshAgent("host-msgs");
    await agent.testChat("Hello");

    const messages = await agent.hostGetMessages();
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello");
  });

  it("_hostGetMessages respects limit", async () => {
    const agent = await freshAgent("host-msgs-limit");
    await agent.testChat("First");
    await agent.testChat("Second");

    const all = await agent.hostGetMessages();
    const limited = await agent.hostGetMessages(2);
    expect(limited.length).toBe(2);
    expect(limited.length).toBeLessThanOrEqual(all.length);
  });

  it("_hostGetSessionInfo returns message count", async () => {
    const agent = await freshAgent("host-info");
    await agent.testChat("Hello");

    const info = await agent.hostGetSessionInfo();
    expect(info.messageCount).toBeGreaterThanOrEqual(2);
  });

  it("_insideInferenceLoop is false outside a turn", async () => {
    const agent = await freshAgent("host-loop-flag");
    const inside = await agent.isInsideInferenceLoop();
    expect(inside).toBe(false);
  });

  it("_insideInferenceLoop is false after a completed turn", async () => {
    const agent = await freshAgent("host-loop-after");
    await agent.testChat("Hello");
    const inside = await agent.isInsideInferenceLoop();
    expect(inside).toBe(false);
  });

  it("_hostSetContext writes to a context block", async () => {
    const agent = await freshSessionAgent("host-set-ctx");
    await agent.hostSetContext("memory", "Set via host bridge");
    const content = await agent.hostGetContext("memory");
    expect(content).toBe("Set via host bridge");
  });

  it("_hostGetContext returns null for non-existent block", async () => {
    const agent = await freshSessionAgent("host-get-ctx-miss");
    const content = await agent.hostGetContext("nonexistent");
    expect(content).toBeNull();
  });

  it("_hostDeleteFile removes a file", async () => {
    const agent = await freshAgent("host-del");
    await agent.hostWriteFile("temp.txt", "delete me");
    const deleted = await agent.hostDeleteFile("temp.txt");
    expect(deleted).toBe(true);
    const content = await agent.hostReadFile("temp.txt");
    expect(content).toBeNull();
  });

  it("_hostDeleteFile returns false for missing file", async () => {
    const agent = await freshAgent("host-del-miss");
    const deleted = await agent.hostDeleteFile("nope.txt");
    expect(deleted).toBe(false);
  });

  it("_hostListFiles lists directory contents", async () => {
    const agent = await freshAgent("host-list");
    await agent.hostWriteFile("dir/a.txt", "aaa");
    await agent.hostWriteFile("dir/b.txt", "bbb");
    const entries = await agent.hostListFiles("dir");
    const names = entries.map((e: { name: string }) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("_hostGetMessages with limit=0 returns empty array", async () => {
    const agent = await freshAgent("host-limit0");
    await agent.testChat("Hello");
    const messages = await agent.hostGetMessages(0);
    expect(messages).toEqual([]);
  });

  it("_hostSendMessage injects a user message", async () => {
    const agent = await freshAgent("host-send");
    await agent.testChat("First");
    await agent.hostSendMessage("Injected message");

    const messages = await agent.hostGetMessages();
    const texts = messages.map((m: { content: string }) => m.content);
    expect(texts).toContain("Injected message");

    const cached = (await agent.getCachedMessagesForTest()) as UIMessage[];
    const lastCached = cached[cached.length - 1];
    expect(lastCached.role).toBe("user");
    expect(lastCached.parts).toEqual([
      { type: "text", text: "Injected message" }
    ]);

    const publicMessages = (await agent.getMessages()) as UIMessage[];
    expect(publicMessages[publicMessages.length - 1]).toEqual(lastCached);
  });
});

// ── beforeTurn TurnConfig overrides ─────────────────────────────

describe("Think — beforeTurn config overrides", () => {
  it("maxSteps override is applied per-turn", async () => {
    const agent = await freshAgent("bt-maxsteps");
    await agent.setTurnConfigOverride({ maxSteps: 1 });
    const result = await agent.testChat("Hello");
    expect(result.done).toBe(true);
  });

  it("beforeTurn still sees original system prompt when override is set", async () => {
    const agent = await freshAgent("bt-system");
    await agent.setTurnConfigOverride({ system: "You are a pirate." });
    await agent.testChat("With override");

    const log = await agent.getBeforeTurnLog();
    expect(log[0].system).toContain("You are a careful, capable assistant");
    expect(log[0].system).toContain("You are running inside a Think agent.");
  });

  it("activeTools override limits tool availability", async () => {
    const agent = await freshAgent("bt-active");
    await agent.setTurnConfigOverride({ activeTools: ["read"] });
    const result = await agent.testChat("Restricted tools");
    expect(result.done).toBe(true);
  });

  it("accepts stable AI SDK call settings from TurnConfig", async () => {
    const agent = await freshAgent("bt-call-settings");
    await agent.setTurnConfigOverride({
      maxOutputTokens: 123,
      temperature: 0.2,
      topP: 0.8,
      topK: 40,
      presencePenalty: 0.1,
      frequencyPenalty: 0.3,
      stopSequences: ["STOP"],
      seed: 1234,
      maxRetries: 0,
      timeout: { totalMs: 10_000, chunkMs: 5_000 },
      headers: { "x-test-turn": "enabled" },
      providerOptions: { test: { mode: "turn" } }
    });

    const result = await agent.testChat("Use call settings");
    const settings = await agent.getLastModelCallSettings();

    expect(result.done).toBe(true);
    expect(settings).toMatchObject({
      maxOutputTokens: 123,
      temperature: 0.2,
      topP: 0.8,
      topK: 40,
      presencePenalty: 0.1,
      frequencyPenalty: 0.3,
      stopSequences: ["STOP"],
      seed: 1234,
      headers: { "x-test-turn": "enabled" },
      providerOptions: { test: { mode: "turn" } }
    });
  });

  it("output override is accepted on TurnConfig and forwarded to streamText", async () => {
    // Regression for #1383 — TurnConfig.output should be a structurally
    // valid field that the AI SDK accepts. We construct the Output spec
    // inside the DO (it contains Promises that can't cross the RPC
    // boundary) and verify the turn completes; the AI SDK will throw at
    // the streamText boundary if the field isn't honored.
    const agent = await freshAgent("bt-output");
    await agent.setTurnConfigOutputText();
    const result = await agent.testChat("Structured-output turn");
    expect(result.done).toBe(true);
  });

  it("experimental_transform override is forwarded to streamText and applied", async () => {
    // #1714 — TurnConfig.experimental_transform should reach streamText so
    // callers can inspect/rewrite the stream. The transform here upper-cases
    // every text-delta; we assert the persisted assistant text is upper-cased.
    const agent = await freshAgent("bt-transform");
    await agent.setResponse("hello from the assistant");
    await agent.setTurnConfigTransform();

    const result = await agent.testChat("Transform turn");
    expect(result.done).toBe(true);

    const messages = (await agent.getMessages()) as UIMessage[];
    const assistant = messages.filter((m) => m.role === "assistant");
    const last = assistant[assistant.length - 1];
    const text = last.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("HELLO FROM THE ASSISTANT");
  });

  it("sends reasoning chunks by default on the chat() path", async () => {
    const agent = await freshAgent("bt-reasoning-default");
    await agent.setReasoningResponse("Final answer", "Visible thinking");

    const result = await agent.testChat("Show reasoning");
    const types = eventTypes(result.events);

    expect(types).toContain("reasoning-start");
    expect(types).toContain("reasoning-delta");
    expect(types).toContain("reasoning-end");
  });

  it("uses the instance-level sendReasoning default", async () => {
    const agent = await freshAgent("bt-reasoning-instance");
    await agent.setSendReasoningDefault(false);
    await agent.setReasoningResponse("Final answer", "Hidden thinking");

    const result = await agent.testChat("Hide reasoning");
    const types = eventTypes(result.events);

    expect(types).not.toContain("reasoning-start");
    expect(types).not.toContain("reasoning-delta");
    expect(types).not.toContain("reasoning-end");
    expect(types).toContain("text-delta");
  });

  it("allows TurnConfig to suppress reasoning for one turn", async () => {
    const agent = await freshAgent("bt-reasoning-turn-false");
    await agent.setReasoningResponse("Final answer", "Hidden thinking");
    await agent.setTurnConfigOverride({ sendReasoning: false });

    const result = await agent.testChat("Hide reasoning this turn");
    const types = eventTypes(result.events);

    expect(types).not.toContain("reasoning-delta");
    expect(types).toContain("text-delta");
  });

  it("allows TurnConfig to send reasoning when the instance default is false", async () => {
    const agent = await freshAgent("bt-reasoning-turn-true");
    await agent.setSendReasoningDefault(false);
    await agent.setReasoningResponse("Final answer", "Visible thinking");
    await agent.setTurnConfigOverride({ sendReasoning: true });

    const result = await agent.testChat("Show reasoning this turn");
    const types = eventTypes(result.events);

    expect(types).toContain("reasoning-delta");
    expect(types).toContain("text-delta");
  });

  it("applies sendReasoning on the WebSocket stream path", async () => {
    const room = "bt-reasoning-ws";
    const agent = await freshAgent(room);
    await agent.setTurnConfigOverride({ sendReasoning: false });
    await agent.setReasoningResponse("Final answer", "Hidden thinking");

    const ws = await connectWS("ThinkTestAgent", room);
    const done = waitForDone(ws);
    sendChatRequest(ws, "Hide reasoning over WebSocket");
    const messages = await done;
    await closeWS(ws);

    const types = websocketChunkTypes(messages);
    expect(types).not.toContain("reasoning-delta");
    expect(types).toContain("text-delta");
  });
});
