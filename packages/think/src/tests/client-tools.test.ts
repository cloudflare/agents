import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { subscribe } from "agents/observability";
import type { UIMessage } from "ai";
import type { ChatResponseResult } from "../think";

const MSG_CHAT_REQUEST = "cf_agent_use_chat_request";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";
const MSG_CHAT_CLEAR = "cf_agent_chat_clear";
const MSG_TOOL_RESULT = "cf_agent_tool_result";
const MSG_TOOL_APPROVAL = "cf_agent_tool_approval";
const MSG_MESSAGE_UPDATED = "cf_agent_message_updated";
const MSG_STREAM_RESUME_REQUEST = "cf_agent_stream_resume_request";
const MSG_STREAM_RESUME_NONE = "cf_agent_stream_resume_none";
const MSG_STREAM_RESUMING = "cf_agent_stream_resuming";

// ── Helpers ──────────────────────────────────────────────────────

async function freshAgent(name?: string) {
  return getAgentByName(env.ThinkClientToolsAgent, name ?? crypto.randomUUID());
}

async function connectWS(room: string) {
  const res = await exports.default.fetch(
    `http://example.com/agents/think-client-tools-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

function collectMessages(
  ws: WebSocket,
  count: number,
  timeout = 3000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    const handler = (e: MessageEvent) => {
      try {
        messages.push(JSON.parse(e.data as string) as Record<string, unknown>);
        if (messages.length >= count) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
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
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

function waitForDoneId(
  ws: WebSocket,
  requestId: string,
  timeout = 10000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for done: ${requestId}`)),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        messages.push(msg);
        if (
          msg.type === MSG_CHAT_RESPONSE &&
          msg.id === requestId &&
          msg.done === true
        ) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // ignore
      }
    };
    ws.addEventListener("message", handler);
  });
}

function waitForMessageOfType(
  ws: WebSocket,
  type: string,
  timeout = 3000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${type}`)),
      timeout
    );
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        if (msg.type === type) {
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

function sendChatRequest(
  ws: WebSocket,
  messages: UIMessage[],
  extra?: Record<string, unknown>
) {
  const id = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      type: MSG_CHAT_REQUEST,
      id,
      init: {
        method: "POST",
        body: JSON.stringify({ messages, ...extra })
      }
    })
  );
  return id;
}

function makeUserMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }]
  };
}

function makeToolMessage(
  toolCallId: string,
  toolName: string,
  state: string,
  extra?: Record<string, unknown>
): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [
      {
        type: `tool-${toolName}`,
        toolCallId,
        toolName,
        state,
        input: { action: "test" },
        ...extra
      } as unknown as UIMessage["parts"][number]
    ]
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
  intervalMs = 25
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await delay(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function waitForActiveTurn(
  agent: { isChatTurnActiveForTest(): Promise<boolean> | boolean },
  timeoutMs = 4000
) {
  await waitUntil(() => agent.isChatTurnActiveForTest(), timeoutMs);
}

async function waitForOverlappingSubmits(
  agent: { getOverlappingSubmitCountForTest(): Promise<number> | number },
  expected: number,
  timeoutMs = 4000
) {
  await waitUntil(async () => {
    const observed = await agent.getOverlappingSubmitCountForTest();
    return observed >= expected;
  }, timeoutMs);
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

// ── Tool result application ──────────────────────────────────────

describe("Think — tool result application", () => {
  it("updates tool part to output-available", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-result-1";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "input-available")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId,
        toolName: "client_action",
        output: "result data"
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const toolPart = assistantMsg!.parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("result data");

    await closeWS(ws);
  });

  it("sets output-error state with errorText", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-error-1";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "input-available")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId,
        toolName: "client_action",
        output: null,
        state: "output-error",
        errorText: "Something went wrong"
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("output-error");
    expect(toolPart.errorText).toBe("Something went wrong");

    await closeWS(ws);
  });

  it("uses default errorText when omitted", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-default-err";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "input-available")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId,
        toolName: "client_action",
        output: null,
        state: "output-error"
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("output-error");
    expect(toolPart.errorText).toBe("Tool execution denied by user");

    await closeWS(ws);
  });

  it("does NOT update tool in output-available state", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-already-done";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "output-available", {
        output: "original"
      })
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId,
        toolName: "client_action",
        output: "overwrite attempt"
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.output).toBe("original");

    await closeWS(ws);
  });

  it("does NOT update tool in output-denied state", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-denied";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "output-denied")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId,
        toolName: "client_action",
        output: "should not apply"
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("output-denied");

    await closeWS(ws);
  });

  it("applies to tool in approval-requested state", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-approval-req";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "approval-requested")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId,
        toolName: "client_action",
        output: "approved result"
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("approved result");

    await closeWS(ws);
  });

  it("applies to tool in approval-responded state", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-approval-resp";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "approval-responded")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId,
        toolName: "client_action",
        output: "post-approval result"
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("output-available");

    await closeWS(ws);
  });
});

// ── Tool approval ────────────────────────────────────────────────

describe("Think — tool approval", () => {
  it("approved=true transitions to approval-responded", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-approve";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "approval-requested")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId,
        approved: true
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("approval-responded");

    await closeWS(ws);
  });

  it("approved=false transitions to output-denied", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-reject";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "approval-requested")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId,
        approved: false
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("output-denied");

    await closeWS(ws);
  });

  it("non-existent toolCallId is a no-op", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage("tc-real", "client_action", "input-available")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc-nonexistent",
        approved: true
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("input-available");

    await closeWS(ws);
  });

  it("does NOT update tool in output-available state", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-already-available";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "output-available", {
        output: "done"
      })
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId,
        approved: true
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("output-available");

    await closeWS(ws);
  });

  it("preserves approval data", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-preserve";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "approval-requested", {
        approval: { id: "approval-123" }
      })
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId,
        approved: true
      })
    );

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("approval-responded");
    const approval = toolPart.approval as Record<string, unknown>;
    expect(approval.id).toBe("approval-123");
    expect(approval.approved).toBe(true);

    await closeWS(ws);
  });
});

// ── Auto-continuation ────────────────────────────────────────────

describe("Think — auto-continuation", () => {
  it("autoContinue: true triggers continuation", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    // Send initial chat that produces a tool call
    const donePromise = waitForDone(ws);
    sendChatRequest(ws, [makeUserMessage("use client tool")], {
      clientTools: [{ name: "client_action", description: "A client tool" }]
    });
    await donePromise;

    // Wait for message broadcast
    await delay(200);

    // Now send tool result with autoContinue
    const continuationDone = waitForDone(ws, 15000);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-client-1",
        toolName: "client_action",
        output: "tool output",
        autoContinue: true
      })
    );
    await continuationDone;

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    // Should have user + assistant (with tool) + continuation assistant
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant).toBeDefined();

    await closeWS(ws);
  });

  it("without autoContinue, no continuation", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-no-continue";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "input-available")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId,
        toolName: "client_action",
        output: "result"
      })
    );

    // Wait and verify no continuation stream started
    await delay(500);
    const messages = (await agent.getMessages()) as UIMessage[];
    // Should still be 2 messages (user + original assistant)
    expect(messages).toHaveLength(2);

    await closeWS(ws);
  });

  it("approval with autoContinue triggers continuation", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    // Send initial chat that produces a tool call
    const donePromise = waitForDone(ws);
    sendChatRequest(ws, [makeUserMessage("use tool")], {
      clientTools: [{ name: "client_action", description: "A client tool" }]
    });
    await donePromise;
    await delay(200);

    // Approve and auto-continue
    const continuationDone = waitForDone(ws, 15000);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc-client-1",
        approved: true,
        autoContinue: true
      })
    );
    await continuationDone;

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    expect(messages.length).toBeGreaterThanOrEqual(2);

    await closeWS(ws);
  });

  it("streams and persists output from an approved server tool continuation (#1627)", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    await agent.setServerApprovalToolMode(true);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const initialDone = waitForDone(ws, 15000);
    sendChatRequest(ws, [makeUserMessage("update my trigger")]);
    const initialFrames = await initialDone;
    const initialChunks = initialFrames
      .filter(
        (frame) =>
          frame.type === MSG_CHAT_RESPONSE &&
          typeof frame.body === "string" &&
          frame.body.length > 0
      )
      .map(
        (frame) => JSON.parse(frame.body as string) as Record<string, unknown>
      );
    expect(
      initialChunks.some(
        (chunk) =>
          chunk.type === "tool-approval-request" &&
          chunk.toolCallId === "tc-server-approval-1"
      )
    ).toBe(true);

    const continuationDone = waitForDone(ws, 15000);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc-server-approval-1",
        approved: true,
        autoContinue: true
      })
    );
    const continuationFrames = await continuationDone;
    const outputUpdateFrame = continuationFrames.find((frame) => {
      if (frame.type !== MSG_MESSAGE_UPDATED) return false;
      const message = frame.message as UIMessage;
      return message.parts.some(
        (part) =>
          "toolCallId" in part &&
          part.toolCallId === "tc-server-approval-1" &&
          "state" in part &&
          part.state === "output-available"
      );
    });
    const continuationComplete = continuationFrames.find(
      (frame) => frame.type === MSG_CHAT_RESPONSE && frame.done === true
    );

    expect(await agent.getServerApprovalToolExecutions()).toBe(1);
    expect(outputUpdateFrame).toBeDefined();
    expect(continuationComplete?.continuation).toBe(true);

    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages
      .flatMap((message) => message.parts)
      .find(
        (part) =>
          "toolCallId" in part && part.toolCallId === "tc-server-approval-1"
      ) as Record<string, unknown> | undefined;
    expect(toolPart).toMatchObject({
      state: "output-available",
      output: { enabled: true }
    });

    await closeWS(ws);
  });

  it("treats a pending approved tool as complete — no spurious transcript-repair backstop (#1627)", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    await agent.setServerApprovalToolMode(true);

    // While its continuation runs, the approved tool sits at
    // `approval-responded` with no result yet. It must NOT be flagged by the
    // incomplete-tool-call backstop: `convertToModelMessages` keeps and
    // executes the call, so flagging it would log a misleading "repair gap"
    // warning and emit a spurious `chat:transcript:repaired` event.
    const repairedToolCallIds: Array<string[] | undefined> = [];
    const unsubscribe = subscribe("transcript", (event) => {
      if (event.type === "chat:transcript:repaired" && event.name === room) {
        repairedToolCallIds.push(event.payload.toolCallIds);
      }
    });

    try {
      const { ws } = await connectWS(room);
      await collectMessages(ws, 3);

      const initialDone = waitForDone(ws, 15000);
      sendChatRequest(ws, [makeUserMessage("update my trigger")]);
      await initialDone;

      const continuationDone = waitForDone(ws, 15000);
      ws.send(
        JSON.stringify({
          type: MSG_TOOL_APPROVAL,
          toolCallId: "tc-server-approval-1",
          approved: true,
          autoContinue: true
        })
      );
      await continuationDone;

      expect(await agent.getServerApprovalToolExecutions()).toBe(1);
      expect(
        repairedToolCallIds.some((ids) => ids?.includes("tc-server-approval-1"))
      ).toBe(false);

      await closeWS(ws);
    } finally {
      unsubscribe();
    }
  });

  it("does not execute a rejected server approval tool and retains denial", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    await agent.setServerApprovalToolMode(true);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const initialDone = waitForDone(ws, 15000);
    sendChatRequest(ws, [makeUserMessage("do not update my trigger")]);
    await initialDone;

    const continuationDone = waitForDone(ws, 15000);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc-server-approval-1",
        approved: false,
        autoContinue: true
      })
    );
    const continuationFrames = await continuationDone;

    expect(await agent.getServerApprovalToolExecutions()).toBe(0);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages
      .flatMap((message) => message.parts)
      .find(
        (part) =>
          "toolCallId" in part && part.toolCallId === "tc-server-approval-1"
      ) as Record<string, unknown> | undefined;
    expect(toolPart?.state).toBe("output-denied");
    expect(
      continuationFrames.find(
        (frame) => frame.type === MSG_CHAT_RESPONSE && frame.done === true
      )?.continuation
    ).toBe(true);

    await closeWS(ws);
  });

  it("persists an approved server tool execution error as terminal output", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    await agent.setServerApprovalToolMode(true);
    await agent.setServerApprovalToolFailure(true);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const initialDone = waitForDone(ws, 15000);
    sendChatRequest(ws, [makeUserMessage("update a broken trigger")]);
    await initialDone;

    const continuationDone = waitForDone(ws, 15000);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc-server-approval-1",
        approved: true,
        autoContinue: true
      })
    );
    await continuationDone;

    expect(await agent.getServerApprovalToolExecutions()).toBe(1);
    const messages = (await agent.getMessages()) as UIMessage[];
    const toolPart = messages
      .flatMap((message) => message.parts)
      .find(
        (part) =>
          "toolCallId" in part && part.toolCallId === "tc-server-approval-1"
      ) as Record<string, unknown> | undefined;
    expect(toolPart).toMatchObject({
      state: "output-error",
      errorText: "Trigger update failed"
    });

    await closeWS(ws);
  });

  it("rejection with autoContinue still triggers continuation", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    // Send initial chat
    const donePromise = waitForDone(ws);
    sendChatRequest(ws, [makeUserMessage("use tool")], {
      clientTools: [{ name: "client_action", description: "A client tool" }]
    });
    await donePromise;
    await delay(200);

    // Reject and auto-continue
    const continuationDone = waitForDone(ws, 15000);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_APPROVAL,
        toolCallId: "tc-client-1",
        approved: false,
        autoContinue: true
      })
    );
    await continuationDone;

    await delay(200);
    const messages = (await agent.getMessages()) as UIMessage[];
    expect(messages.length).toBeGreaterThanOrEqual(2);

    await closeWS(ws);
  });

  it("waits for ALL parallel client-tool results before continuing (#1649)", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    // Seed an assistant turn that emitted TWO parallel client tool calls — the
    // shape `addToolOutput` produces when the model fans out in a single step.
    await agent.persistToolCallMessage([
      makeUserMessage("use two tools"),
      {
        id: "assistant-parallel",
        role: "assistant",
        parts: [
          {
            type: "tool-client_action",
            toolCallId: "tc-fast",
            toolName: "client_action",
            state: "input-available",
            input: { action: "fast" }
          },
          {
            type: "tool-client_action",
            toolCallId: "tc-slow",
            toolName: "client_action",
            state: "input-available",
            input: { action: "slow" }
          }
        ]
      } as unknown as UIMessage
    ]);
    await agent.clearResponseLog();

    // A premature continuation (firing on the fast result while `tc-slow` is
    // still in flight) would flip `tc-slow` to errored via transcript repair
    // and emit a repaired event for it.
    const repairedToolCallIds: Array<string[] | undefined> = [];
    const unsubscribe = subscribe("transcript", (event) => {
      if (event.type === "chat:transcript:repaired" && event.name === room) {
        repairedToolCallIds.push(event.payload.toolCallIds);
      }
    });

    try {
      // Fast tool resolves immediately, with autoContinue.
      ws.send(
        JSON.stringify({
          type: MSG_TOOL_RESULT,
          toolCallId: "tc-fast",
          toolName: "client_action",
          output: "fast output",
          autoContinue: true
        })
      );

      // Wait well past the 50ms coalesce window WITHOUT sending the slow
      // result. The old behavior fired a continuation here (it saw only the
      // fast result and treated `tc-slow` as an orphan).
      await delay(400);

      let log = (await agent.getResponseLog()) as ChatResponseResult[];
      expect(log.filter((entry) => entry.continuation).length).toBe(0);

      // Slow tool resolves later, with autoContinue: this completes the batch
      // and must trigger exactly ONE continuation.
      const continuationDone = waitForDone(ws, 15000);
      ws.send(
        JSON.stringify({
          type: MSG_TOOL_RESULT,
          toolCallId: "tc-slow",
          toolName: "client_action",
          output: "slow output",
          autoContinue: true
        })
      );
      await continuationDone;
      await delay(200);

      log = (await agent.getResponseLog()) as ChatResponseResult[];
      expect(log.filter((entry) => entry.continuation).length).toBe(1);

      // `tc-slow` was never flipped to errored by a premature repair.
      expect(repairedToolCallIds.flat()).not.toContain("tc-slow");

      const messages = (await agent.getMessages()) as UIMessage[];
      const assistant = messages.find((m) => m.id === "assistant-parallel")!;
      const partFor = (toolCallId: string) =>
        assistant.parts.find(
          (p) => (p as Record<string, unknown>).toolCallId === toolCallId
        ) as Record<string, unknown>;
      expect(partFor("tc-fast").state).toBe("output-available");
      expect(partFor("tc-fast").output).toBe("fast output");
      expect(partFor("tc-slow").state).toBe("output-available");
      expect(partFor("tc-slow").output).toBe("slow output");
    } finally {
      unsubscribe();
    }

    await closeWS(ws);
  });

  it("serializes overlapping tool-result applies so neither clobbers the other (#1649)", async () => {
    const agent = await freshAgent();
    // Two overlapping read-modify-writes through the interaction-apply queue.
    // Without serialization the second reads the stale value before the first
    // commits and the result is 1; serialized, the second waits and it is 2.
    const result = await agent.testInteractionApplySerialization();
    expect(result).toBe(2);
  });

  it("applies a client tool result delivered before the assistant message is persisted (#1649)", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    // Deterministic reproduction of the streaming race: the tool call exists
    // ONLY in the in-flight accumulator (not yet persisted) when the result
    // arrives. A storage-only apply misses it, and the end-of-stream persist
    // then writes `input-available`, which transcript repair later errors with
    // "The tool call was interrupted before a result was recorded." Applying to
    // the accumulator lets the result ride into the persist.
    const result = await agent.simulateMidStreamClientToolResult({
      toolCallId: "tc-midstream-1",
      output: "mid-stream result"
    });
    expect(result.state).toBe("output-available");
    expect(result.output).toBe("mid-stream result");
  });

  it("applies a client tool approval delivered before the assistant message is persisted (#1649)", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    // Approvals flow through the same `_applyToolUpdateToMessages` path, so the
    // mid-stream fix must cover them too: an `approval-requested` part that
    // exists only in the in-flight accumulator must reach `approval-responded`
    // rather than being dropped and repaired as interrupted.
    const result = await agent.simulateMidStreamClientToolApproval({
      toolCallId: "tc-midstream-approval-1",
      approved: true
    });
    expect(result.state).toBe("approval-responded");
  });

  it("applies a client tool result that arrives mid-stream over the WebSocket (#1649)", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    // Hold the stream open after the client tool call so the result can arrive
    // before the end-of-stream persist (the real #1649 window).
    await agent.setSlowClientToolStreamMode(true, 25, 16);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const repairedToolCallIds: Array<string[] | undefined> = [];
    const unsubscribe = subscribe("transcript", (event) => {
      if (event.type === "chat:transcript:repaired" && event.name === room) {
        repairedToolCallIds.push(event.payload.toolCallIds);
      }
    });

    try {
      sendChatRequest(ws, [makeUserMessage("do the thing")], {
        clientTools: [{ name: "client_action", description: "A client tool" }]
      });

      // Wait until the streaming turn has exposed the client tool call, then
      // resolve it WHILE the stream is still open — deterministic, no timing
      // guess. On `main` this result lands before the message is persisted and
      // is dropped.
      await waitUntil(async () => {
        const state = await agent.streamingToolCallState("tc-client-1");
        if (state === undefined) return false;
        if (state !== "input-available") {
          throw new Error(`unexpected streaming tool state: ${state}`);
        }
        return true;
      }, 8000);
      ws.send(
        JSON.stringify({
          type: MSG_TOOL_RESULT,
          toolCallId: "tc-client-1",
          toolName: "client_action",
          output: "mid-stream output",
          autoContinue: true
        })
      );

      // The continuation only runs once the result has been recorded, so
      // waiting for it confirms the result survived.
      await waitUntil(async () => {
        const log = (await agent.getResponseLog()) as ChatResponseResult[];
        return log.some((entry) => entry.continuation);
      }, 8000);
      await delay(100);

      const messages = (await agent.getMessages()) as UIMessage[];
      const toolPart = messages
        .flatMap((m) => m.parts as Array<Record<string, unknown>>)
        .find((p) => p.toolCallId === "tc-client-1");
      expect(toolPart?.state).toBe("output-available");
      expect(toolPart?.output).toBe("mid-stream output");
      // The result was applied in time, so repair never errored the call.
      expect(repairedToolCallIds.flat()).not.toContain("tc-client-1");
    } finally {
      unsubscribe();
    }

    await closeWS(ws);
  }, 25000);

  it("does not clobber siblings when parallel results arrive concurrently (#1649)", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    // Three parallel client tool calls in a single assistant step.
    await agent.persistToolCallMessage([
      makeUserMessage("use three tools"),
      {
        id: "assistant-concurrent",
        role: "assistant",
        parts: [
          {
            type: "tool-client_action",
            toolCallId: "tc-a",
            toolName: "client_action",
            state: "input-available",
            input: { action: "a" }
          },
          {
            type: "tool-client_action",
            toolCallId: "tc-b",
            toolName: "client_action",
            state: "input-available",
            input: { action: "b" }
          },
          {
            type: "tool-client_action",
            toolCallId: "tc-c",
            toolName: "client_action",
            state: "input-available",
            input: { action: "c" }
          }
        ]
      } as unknown as UIMessage
    ]);
    await agent.clearResponseLog();

    const repairedToolCallIds: Array<string[] | undefined> = [];
    const unsubscribe = subscribe("transcript", (event) => {
      if (event.type === "chat:transcript:repaired" && event.name === room) {
        repairedToolCallIds.push(event.payload.toolCallIds);
      }
    });

    try {
      // Fire all three results back-to-back WITHOUT awaiting between sends. Each
      // apply is a read-modify-write of the whole assistant message; without
      // serialization they read the same all-`input-available` snapshot and the
      // last write clobbers its siblings back to `input-available`.
      const continuationDone = waitForDone(ws, 15000);
      for (const id of ["tc-a", "tc-b", "tc-c"]) {
        ws.send(
          JSON.stringify({
            type: MSG_TOOL_RESULT,
            toolCallId: id,
            toolName: "client_action",
            output: `${id} output`,
            autoContinue: true
          })
        );
      }
      await continuationDone;
      await delay(200);

      // All three results survived — none was clobbered back to input-available.
      const messages = (await agent.getMessages()) as UIMessage[];
      const assistant = messages.find((m) => m.id === "assistant-concurrent")!;
      const partFor = (toolCallId: string) =>
        assistant.parts.find(
          (p) => (p as Record<string, unknown>).toolCallId === toolCallId
        ) as Record<string, unknown>;
      for (const id of ["tc-a", "tc-b", "tc-c"]) {
        expect(partFor(id).state).toBe("output-available");
        expect(partFor(id).output).toBe(`${id} output`);
      }

      // No sibling was flipped to errored by a premature repair.
      expect(repairedToolCallIds.flat()).toEqual([]);

      // Exactly one continuation ran for the completed batch.
      const log = (await agent.getResponseLog()) as ChatResponseResult[];
      expect(log.filter((entry) => entry.continuation).length).toBe(1);
    } finally {
      unsubscribe();
    }

    await closeWS(ws);
  });

  it("holds the barrier when a settled dynamic-tool sits beside a pending tool (#1649)", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    // Parallel batch mixing a `dynamic-tool` part with a regular tool part —
    // both `input-available`. `dynamic-tool` must be recognized as a tool so a
    // settled one still counts toward the mid-batch barrier.
    await agent.persistToolCallMessage([
      makeUserMessage("use a dynamic tool and a regular tool"),
      {
        id: "assistant-dynamic",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "dyn_action",
            toolCallId: "tc-dyn",
            state: "input-available",
            input: { action: "dyn" }
          },
          {
            type: "tool-client_action",
            toolCallId: "tc-reg",
            toolName: "client_action",
            state: "input-available",
            input: { action: "reg" }
          }
        ]
      } as unknown as UIMessage
    ]);
    await agent.clearResponseLog();

    // Resolve the dynamic tool first (autoContinue). The regular tool is still
    // pending, so the continuation must NOT run yet.
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-dyn",
        toolName: "dyn_action",
        output: "dyn output",
        autoContinue: true
      })
    );

    await delay(400);
    let log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.filter((entry) => entry.continuation).length).toBe(0);

    // Resolve the regular tool: now the batch is complete → one continuation.
    const continuationDone = waitForDone(ws, 15000);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-reg",
        toolName: "client_action",
        output: "reg output",
        autoContinue: true
      })
    );
    await continuationDone;
    await delay(200);

    log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.filter((entry) => entry.continuation).length).toBe(1);

    await closeWS(ws);
  });
});

// ── Client tool schemas ──────────────────────────────────────────

describe("Think — client tool schemas", () => {
  it("clientTools from chat request are passed to the inference loop", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const donePromise = waitForDone(ws);
    sendChatRequest(ws, [makeUserMessage("hello")], {
      clientTools: [
        { name: "tool_a", description: "Tool A" },
        {
          name: "tool_b",
          description: "Tool B",
          parameters: { type: "object" }
        }
      ]
    });
    await donePromise;

    const captured = await agent.getCapturedClientTools();
    expect(captured).toBeDefined();
    expect(captured).toHaveLength(2);
    expect(captured![0].name).toBe("tool_a");
    expect(captured![1].name).toBe("tool_b");

    await closeWS(ws);
  });

  it("clientTools from TOOL_RESULT update stored tools", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-schema-update";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "input-available")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId,
        toolName: "client_action",
        output: "result",
        clientTools: [{ name: "new_tool", description: "New tool" }]
      })
    );

    await delay(200);
    const captured = await agent.getCapturedClientTools();
    expect(captured).toBeDefined();
    expect(captured).toHaveLength(1);
    expect(captured![0].name).toBe("new_tool");

    await closeWS(ws);
  });

  it("clear clears stored client tools", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    // Set tools via a chat request
    await agent.setTextOnlyMode(true);
    const donePromise = waitForDone(ws);
    sendChatRequest(ws, [makeUserMessage("hello")], {
      clientTools: [{ name: "tool_a", description: "Tool A" }]
    });
    await donePromise;

    let captured = await agent.getCapturedClientTools();
    expect(captured).toBeDefined();

    // Clear
    ws.send(JSON.stringify({ type: MSG_CHAT_CLEAR }));
    await delay(200);

    captured = await agent.getCapturedClientTools();
    expect(captured).toBeUndefined();

    await closeWS(ws);
  });

  it("new request without clientTools clears stored tools", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    // First request with tools
    await agent.setTextOnlyMode(true);
    let donePromise = waitForDone(ws);
    sendChatRequest(ws, [makeUserMessage("hello")], {
      clientTools: [{ name: "tool_a", description: "Tool A" }]
    });
    await donePromise;

    let captured = await agent.getCapturedClientTools();
    expect(captured).toBeDefined();

    // Second request explicitly without tools
    donePromise = waitForDone(ws);
    sendChatRequest(ws, [makeUserMessage("hello again")], {
      clientTools: []
    });
    await donePromise;

    captured = await agent.getCapturedClientTools();
    expect(captured).toBeUndefined();

    await closeWS(ws);
  });
});

// ── Broadcast and persistence ────────────────────────────────────

describe("Think — tool broadcast and persistence", () => {
  it("broadcasts MESSAGE_UPDATED after tool result", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-broadcast";
    await agent.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "input-available")
    ]);

    const updatePromise = waitForMessageOfType(ws, MSG_MESSAGE_UPDATED);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId,
        toolName: "client_action",
        output: "result"
      })
    );

    const update = await updatePromise;
    expect(update.type).toBe(MSG_MESSAGE_UPDATED);
    const message = update.message as Record<string, unknown>;
    expect(message).toBeDefined();

    await closeWS(ws);
  });

  it("tool state survives across agent instances", async () => {
    const room = crypto.randomUUID();
    const agent1 = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    const toolCallId = "tc-persist";
    await agent1.persistToolCallMessage([
      makeUserMessage("hello"),
      makeToolMessage(toolCallId, "client_action", "input-available")
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId,
        toolName: "client_action",
        output: "persisted result"
      })
    );

    await delay(200);
    await closeWS(ws);

    // Get a new agent instance (same room = same DO)
    const agent2 = await freshAgent(room);
    const messages = (await agent2.getMessages()) as UIMessage[];
    const toolPart = messages.find((m) => m.role === "assistant")!
      .parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("persisted result");
  });

  it("other tabs receive continuation stream chunks", async () => {
    const room = crypto.randomUUID();
    await freshAgent(room);
    const { ws: ws1 } = await connectWS(room);
    const { ws: ws2 } = await connectWS(room);
    await collectMessages(ws1, 3);
    await collectMessages(ws2, 3);

    // Tab 1 sends chat
    const donePromise1 = waitForDone(ws1);
    sendChatRequest(ws1, [makeUserMessage("use tool")], {
      clientTools: [{ name: "client_action", description: "A client tool" }]
    });
    await donePromise1;
    // Tab 2 also receives the stream
    await delay(200);

    // Tab 1 sends tool result with autoContinue
    const continuationDone1 = waitForDone(ws1, 15000);
    const continuationDone2 = waitForDone(ws2, 15000);
    ws1.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-client-1",
        toolName: "client_action",
        output: "tool output",
        autoContinue: true
      })
    );

    await continuationDone1;
    // Tab 2 should also receive the continuation stream
    const tab2Messages = await continuationDone2;
    const tab2Done = tab2Messages.find(
      (m) => m.type === MSG_CHAT_RESPONSE && m.done === true
    );
    expect(tab2Done).toBeDefined();

    await closeWS(ws1);
    await closeWS(ws2);
  });
});

// ── Resume coordination during pending continuation ──────────────

describe("resume coordination during pending continuation", () => {
  it("does not send STREAM_RESUME_NONE for an immediate resume request after tool output", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await delay(100);

    const userMsg: UIMessage = {
      id: "msg-immediate-resume-user",
      role: "user",
      parts: [{ type: "text", text: "hi" }]
    } as UIMessage;

    const initialDone = waitForDone(ws, 10000);
    ws.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
        id: "req-immediate-resume",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMsg] })
        }
      })
    );
    await initialDone;

    await agent.persistToolCallMessage([
      userMsg,
      {
        id: "assistant-immediate-resume",
        role: "assistant",
        parts: [
          {
            type: "tool-client_action",
            toolCallId: "tc-immediate-resume",
            state: "input-available",
            input: { action: "test" }
          }
        ]
      } as unknown as UIMessage
    ]);

    const resumeResponse = Promise.race([
      waitForMessageOfType(ws, MSG_STREAM_RESUMING, 5000).then(
        () => "resuming" as const
      ),
      waitForMessageOfType(ws, MSG_STREAM_RESUME_NONE, 5000).then(
        () => "none" as const
      )
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-immediate-resume",
        toolName: "client_action",
        output: "done",
        autoContinue: true
      })
    );
    ws.send(JSON.stringify({ type: MSG_STREAM_RESUME_REQUEST }));

    const result = await resumeResponse;
    expect(result).toBe("resuming");

    await waitForDone(ws, 10000);
    await closeWS(ws);
  });

  it("continues when the initiating connection closes before coalescing finishes", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await delay(100);

    const userMsg: UIMessage = {
      id: "msg-close-before-coalesce-user",
      role: "user",
      parts: [{ type: "text", text: "hi" }]
    } as UIMessage;

    const initialDone = waitForDone(ws, 10000);
    ws.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
        id: "req-close-before-coalesce",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMsg] })
        }
      })
    );
    await initialDone;

    await agent.clearResponseLog();
    await agent.persistToolCallMessage([
      userMsg,
      {
        id: "assistant-close-before-coalesce",
        role: "assistant",
        parts: [
          {
            type: "tool-client_action",
            toolCallId: "tc-close-before-coalesce",
            state: "input-available",
            input: { action: "test" }
          }
        ]
      } as unknown as UIMessage
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-close-before-coalesce",
        toolName: "client_action",
        output: "done",
        autoContinue: true
      })
    );

    await delay(10);
    await closeWS(ws);

    await waitUntil(async () => {
      const log = (await agent.getResponseLog()) as ChatResponseResult[];
      return log.some((entry) => entry.continuation);
    }, 10000);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.some((entry) => entry.continuation)).toBe(true);
  });

  it("holds STREAM_RESUME_REQUEST while continuation is pending", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await delay(100);

    const userMsg: UIMessage = {
      id: "msg-resume-hold-user",
      role: "user",
      parts: [{ type: "text", text: "hi" }]
    } as UIMessage;

    const initialDone = waitForDone(ws, 10000);
    ws.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
        id: "req-resume-hold",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMsg] })
        }
      })
    );
    await initialDone;

    await agent.persistToolCallMessage([
      userMsg,
      {
        id: "assistant-resume-hold",
        role: "assistant",
        parts: [
          {
            type: "tool-client_action",
            toolCallId: "tc-resume-hold",
            state: "input-available",
            input: { action: "test" }
          }
        ]
      } as unknown as UIMessage
    ]);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-resume-hold",
        toolName: "client_action",
        output: "done",
        autoContinue: true
      })
    );

    await delay(20);

    const resumeResponse = waitForMessageOfType(ws, MSG_STREAM_RESUMING, 5000)
      .then(() => "resuming" as const)
      .catch(() => "timeout" as const);

    ws.send(JSON.stringify({ type: MSG_STREAM_RESUME_REQUEST }));

    const result = await resumeResponse;
    expect(result).toBe("resuming");

    await waitForDone(ws, 10000);
    await closeWS(ws);
  });

  it("sends STREAM_RESUME_NONE to non-initiating connections during active continuation", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws: ws1 } = await connectWS(room);
    const { ws: ws2 } = await connectWS(room);
    await delay(100);

    const userMsg: UIMessage = {
      id: "msg-resume-none-user",
      role: "user",
      parts: [{ type: "text", text: "hi" }]
    } as UIMessage;

    const initialDone = waitForDone(ws1, 10000);
    ws1.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
        id: "req-resume-none",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMsg] })
        }
      })
    );
    await initialDone;

    await agent.persistToolCallMessage([
      userMsg,
      {
        id: "assistant-resume-none",
        role: "assistant",
        parts: [
          {
            type: "tool-client_action",
            toolCallId: "tc-resume-none",
            state: "input-available",
            input: { action: "test" }
          }
        ]
      } as unknown as UIMessage
    ]);

    ws1.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-resume-none",
        toolName: "client_action",
        output: "done",
        autoContinue: true
      })
    );

    await waitForDone(ws1, 10000);
    await delay(100);

    const nonePromise = waitForMessageOfType(ws2, MSG_STREAM_RESUME_NONE, 3000);
    ws2.send(JSON.stringify({ type: MSG_STREAM_RESUME_REQUEST }));

    const noneMsg = await nonePromise;
    expect(noneMsg.type).toBe(MSG_STREAM_RESUME_NONE);

    await closeWS(ws1);
    await closeWS(ws2);
  });
});

// ── Deferred continuation ────────────────────────────────────────

describe("deferred continuation", () => {
  it("coalesces parallel tool results into a single continuation regardless of arrival order (#1649)", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await delay(100);

    const userMsg: UIMessage = {
      id: "msg-deferred-user",
      role: "user",
      parts: [{ type: "text", text: "hi" }]
    } as UIMessage;

    const initialDone = waitForDone(ws, 10000);
    ws.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
        id: "req-deferred",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMsg] })
        }
      })
    );
    await initialDone;

    await agent.persistToolCallMessage([
      userMsg,
      {
        id: "assistant-deferred-1",
        role: "assistant",
        parts: [
          {
            type: "tool-client_action",
            toolCallId: "tc-deferred-1",
            state: "input-available",
            input: { action: "first" }
          },
          {
            type: "tool-client_action",
            toolCallId: "tc-deferred-2",
            state: "input-available",
            input: { action: "second" }
          }
        ]
      } as unknown as UIMessage
    ]);
    await agent.clearResponseLog();

    // First result arrives and auto-continues — but the second tool call is
    // still in flight, so no continuation may run yet (it would error the
    // sibling via transcript repair).
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-deferred-1",
        toolName: "client_action",
        output: "first done",
        autoContinue: true
      })
    );

    // Hold past the coalesce window with the batch still incomplete.
    await delay(300);
    let log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.filter((entry) => entry.continuation).length).toBe(0);

    // Second result completes the batch: exactly one continuation runs.
    const continuationDone = waitForDone(ws, 10000);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-deferred-2",
        toolName: "client_action",
        output: "second done",
        autoContinue: true
      })
    );
    await continuationDone;
    await delay(200);

    log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.filter((entry) => entry.continuation).length).toBe(1);

    const stored = await agent.getMessages();
    const assistantMessages = (stored as UIMessage[]).filter(
      (m: UIMessage) => m.role === "assistant"
    );
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2);

    await closeWS(ws);
  });
});

// ── onChatResponse from WebSocket path ───────────────────────────

describe("Think — onChatResponse via WebSocket", () => {
  it("fires onChatResponse after WebSocket chat request", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setTextOnlyMode(true);
    const donePromise = waitForDone(ws);
    sendChatRequest(ws, [makeUserMessage("hello from ws")]);
    await donePromise;

    await delay(200);
    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0].status).toBe("completed");
    expect(log[0].continuation).toBe(false);
    expect(log[0].message.role).toBe("assistant");

    await closeWS(ws);
  });

  it("fires onChatResponse with continuation=true after auto-continuation", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    // Initial chat produces a tool call
    const donePromise = waitForDone(ws);
    sendChatRequest(ws, [makeUserMessage("use client tool")], {
      clientTools: [{ name: "client_action", description: "A client tool" }]
    });
    await donePromise;
    await delay(200);

    // Tool result with autoContinue triggers continuation
    const continuationDone = waitForDone(ws, 15000);
    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-client-1",
        toolName: "client_action",
        output: "tool output",
        autoContinue: true
      })
    );
    await continuationDone;
    await delay(200);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.length).toBeGreaterThanOrEqual(2);

    const initialHook = log[0];
    expect(initialHook.status).toBe("completed");
    expect(initialHook.continuation).toBe(false);

    const continuationHook = log[log.length - 1];
    expect(continuationHook.status).toBe("completed");
    expect(continuationHook.continuation).toBe(true);

    await closeWS(ws);
  });
});

// ── Custom body via WebSocket ─────────────────────────────────────

describe("Think — custom body via WebSocket", () => {
  it("body fields persist and are available after turn", async () => {
    const room = crypto.randomUUID();
    await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    // Send request with custom body fields
    const donePromise = waitForDone(ws);
    const id = crypto.randomUUID();
    ws.send(
      JSON.stringify({
        type: MSG_CHAT_REQUEST,
        id,
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [makeUserMessage("hello")],
            model: "fast-model",
            temperature: 0.7
          })
        }
      })
    );
    await donePromise;
    await delay(200);

    // Verify turn completed
    const agent = await freshAgent(room);
    const messages = (await agent.getMessages()) as UIMessage[];
    expect(messages.length).toBeGreaterThanOrEqual(2);

    await closeWS(ws);
  });

  it("body is cleared when request has no custom fields", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setTextOnlyMode(true);

    // First request with custom body
    let donePromise = waitForDone(ws);
    sendChatRequest(ws, [makeUserMessage("with body")], {
      model: "fast"
    });
    await donePromise;

    // Second request without custom body — should clear
    donePromise = waitForDone(ws);
    sendChatRequest(ws, [makeUserMessage("no body")]);
    await donePromise;

    await delay(200);
    await closeWS(ws);
  });
});

// ── Regeneration (branching) ─────────────────────────────────────

describe("Think — regeneration", () => {
  it("regenerate-message creates a sibling branch, not a replacement", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setTextOnlyMode(true);

    // First turn: user + assistant
    const userMsg = makeUserMessage("explain monads");
    const donePromise1 = waitForDone(ws);
    sendChatRequest(ws, [userMsg]);
    await donePromise1;
    await delay(200);

    const messagesAfterFirst = (await agent.getMessages()) as UIMessage[];
    expect(messagesAfterFirst).toHaveLength(2);
    const firstAssistant = messagesAfterFirst[1];
    expect(firstAssistant.role).toBe("assistant");

    // Regenerate: send truncated list (just the user message) with trigger
    const donePromise2 = waitForDone(ws);
    sendChatRequest(ws, [userMsg], { trigger: "regenerate-message" });
    await donePromise2;
    await delay(200);

    // getHistory follows latest leaf — should see the NEW response
    const messagesAfterRegen = (await agent.getMessages()) as UIMessage[];
    expect(messagesAfterRegen).toHaveLength(2);
    expect(messagesAfterRegen[0].id).toBe(userMsg.id);
    const secondAssistant = messagesAfterRegen[1];
    expect(secondAssistant.role).toBe("assistant");
    // The new response has a different ID (different branch)
    expect(secondAssistant.id).not.toBe(firstAssistant.id);

    // Both responses are accessible via getBranches
    const branches = (await agent.getBranches(userMsg.id)) as UIMessage[];
    expect(branches).toHaveLength(2);
    expect(branches.map((b: UIMessage) => b.id)).toContain(firstAssistant.id);
    expect(branches.map((b: UIMessage) => b.id)).toContain(secondAssistant.id);

    await closeWS(ws);
  });

  it("multiple regenerations create multiple branches", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setTextOnlyMode(true);

    const userMsg = makeUserMessage("write a poem");

    // First turn
    let donePromise = waitForDone(ws);
    sendChatRequest(ws, [userMsg]);
    await donePromise;
    await delay(200);

    // Regenerate twice
    donePromise = waitForDone(ws);
    sendChatRequest(ws, [userMsg], { trigger: "regenerate-message" });
    await donePromise;
    await delay(200);

    donePromise = waitForDone(ws);
    sendChatRequest(ws, [userMsg], { trigger: "regenerate-message" });
    await donePromise;
    await delay(200);

    // History shows latest branch (2 messages: user + latest assistant)
    const messages = (await agent.getMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);

    // All three versions are in the tree as branches
    const branches = (await agent.getBranches(userMsg.id)) as UIMessage[];
    expect(branches).toHaveLength(3);
    expect(branches.every((b: UIMessage) => b.role === "assistant")).toBe(true);

    await closeWS(ws);
  });

  it("regeneration preserves conversation history before the branch point", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setTextOnlyMode(true);

    // Build a multi-turn conversation
    const user1 = makeUserMessage("hello");
    let donePromise = waitForDone(ws);
    sendChatRequest(ws, [user1]);
    await donePromise;
    await delay(200);

    const afterTurn1 = (await agent.getMessages()) as UIMessage[];
    const assistant1 = afterTurn1[1];

    const user2 = makeUserMessage("tell me more");
    donePromise = waitForDone(ws);
    sendChatRequest(ws, [user1, assistant1, user2]);
    await donePromise;
    await delay(200);

    // Now regenerate the second response — send [user1, assistant1, user2]
    donePromise = waitForDone(ws);
    sendChatRequest(ws, [user1, assistant1, user2], {
      trigger: "regenerate-message"
    });
    await donePromise;
    await delay(200);

    // History should be: user1 -> assistant1 -> user2 -> new_assistant2
    const messages = (await agent.getMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);
    expect(messages[0].id).toBe(user1.id);
    expect(messages[1].id).toBe(assistant1.id);
    expect(messages[2].id).toBe(user2.id);
    expect(messages[3].role).toBe("assistant");

    // user2 should have 2 branches (old + new assistant)
    const branches = (await agent.getBranches(user2.id)) as UIMessage[];
    expect(branches).toHaveLength(2);

    await closeWS(ws);
  });

  it("regeneration fires onChatResponse", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setTextOnlyMode(true);

    const userMsg = makeUserMessage("test regen hook");
    let donePromise = waitForDone(ws);
    sendChatRequest(ws, [userMsg]);
    await donePromise;
    await delay(200);

    // Regenerate
    donePromise = waitForDone(ws);
    sendChatRequest(ws, [userMsg], { trigger: "regenerate-message" });
    await donePromise;
    await delay(200);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(2);
    expect(log[0].status).toBe("completed");
    expect(log[1].status).toBe("completed");

    await closeWS(ws);
  });

  it("regeneration with empty message list is a normal submit", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setTextOnlyMode(true);

    // Send regenerate with a user message but no prior context — treated as normal
    const userMsg = makeUserMessage("fresh start");
    const donePromise = waitForDone(ws);
    sendChatRequest(ws, [userMsg], { trigger: "regenerate-message" });
    await donePromise;
    await delay(200);

    const messages = (await agent.getMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");

    await closeWS(ws);
  });
});

// ── Message concurrency strategies ───────────────────────────────

describe("Think — messageConcurrency", () => {
  it("queue: processes all overlapping submits in order", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setSlowStreamMode(true, 30, 3);

    const done1 = waitForDone(ws, 10000);
    sendChatRequest(ws, [makeUserMessage("First")]);
    await delay(10);
    sendChatRequest(ws, [makeUserMessage("Second")]);

    await done1;
    await waitForDone(ws, 10000);
    await delay(200);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.length).toBe(2);

    await closeWS(ws);
  });

  it("latest: only newest overlapping submit runs", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setSlowStreamMode(true, 100, 15);
    await agent.setMessageConcurrency("latest");

    const request1 = sendChatRequest(ws, [makeUserMessage("First")]);
    const done1 = waitForDoneId(ws, request1, 10000);
    await waitForActiveTurn(agent);
    sendChatRequest(ws, [makeUserMessage("Second")]);
    sendChatRequest(ws, [makeUserMessage("Third")]);
    await waitForOverlappingSubmits(agent, 2);

    await done1;
    await waitForDone(ws, 10000);
    await delay(200);

    const messages = (await agent.getMessages()) as UIMessage[];
    const userMessages = messages.filter((m: UIMessage) => m.role === "user");
    expect(userMessages.length).toBe(3);

    await closeWS(ws);
  });

  it("drop: rejects overlapping submits", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setSlowStreamMode(true, 100, 15);
    await agent.setMessageConcurrency("drop");

    const request1 = sendChatRequest(ws, [makeUserMessage("First")]);
    const done1 = waitForDoneId(ws, request1, 10000);
    await waitForActiveTurn(agent);

    const request2 = sendChatRequest(ws, [makeUserMessage("Second")]);
    const done2 = waitForDoneId(ws, request2, 3000);
    await done2;

    await done1;
    await delay(200);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.length).toBe(1);

    const messages = (await agent.getMessages()) as UIMessage[];
    const userMessages = messages.filter((m: UIMessage) => m.role === "user");
    expect(userMessages.length).toBe(1);

    await closeWS(ws);
  });

  it("merge: all user messages preserved, single model turn for overlapping", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setSlowStreamMode(true, 100, 15);
    await agent.setMessageConcurrency("merge");

    const request1 = sendChatRequest(ws, [makeUserMessage("First")]);
    const done1 = waitForDoneId(ws, request1, 10000);
    await waitForActiveTurn(agent);
    sendChatRequest(ws, [makeUserMessage("Second")]);
    sendChatRequest(ws, [makeUserMessage("Third")]);
    await waitForOverlappingSubmits(agent, 2);

    await done1;
    await waitForDone(ws, 10000);
    await delay(200);

    const messages = (await agent.getMessages()) as UIMessage[];
    const userMessages = messages.filter((m: UIMessage) => m.role === "user");
    expect(userMessages.length).toBe(3);

    await closeWS(ws);
  });

  it("debounce: waits for quiet period", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setSlowStreamMode(true, 100, 10);
    await agent.setMessageConcurrency({
      strategy: "debounce",
      debounceMs: 100
    });

    const request1 = sendChatRequest(ws, [makeUserMessage("First")]);
    const done1 = waitForDoneId(ws, request1, 10000);
    await waitForActiveTurn(agent);
    sendChatRequest(ws, [makeUserMessage("Second")]);
    await waitForOverlappingSubmits(agent, 1);

    await done1;
    await waitForDone(ws, 10000);
    await delay(200);

    const messages = (await agent.getMessages()) as UIMessage[];
    const userMessages = messages.filter((m: UIMessage) => m.role === "user");
    expect(userMessages.length).toBe(2);

    await closeWS(ws);
  });

  it("only applies to submit-message, not regenerate-message", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setSlowStreamMode(true, 30, 3);
    await agent.setMessageConcurrency("drop");

    const userMsg = makeUserMessage("Hello");
    const done1 = waitForDone(ws, 10000);
    sendChatRequest(ws, [userMsg]);
    await done1;
    await delay(200);

    await agent.clearResponseLog();
    const done2 = waitForDone(ws, 10000);
    sendChatRequest(ws, [userMsg], { trigger: "regenerate-message" });
    await done2;
    await delay(200);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.length).toBe(1);

    await closeWS(ws);
  });

  it("clear skips queued latest submits", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setSlowStreamMode(true, 100, 15);
    await agent.setMessageConcurrency("latest");

    sendChatRequest(ws, [makeUserMessage("First")]);
    await waitForActiveTurn(agent);
    sendChatRequest(ws, [makeUserMessage("Second")]);
    await waitForOverlappingSubmits(agent, 1);

    ws.send(JSON.stringify({ type: MSG_CHAT_CLEAR }));
    await delay(500);

    const messages = (await agent.getMessages()) as UIMessage[];
    expect(messages.length).toBe(0);

    await closeWS(ws);
  });

  it("post-clear submits are not treated as overlapping", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setTextOnlyMode(true);
    await agent.setMessageConcurrency("drop");

    const done1 = waitForDone(ws, 10000);
    sendChatRequest(ws, [makeUserMessage("Before clear")]);
    await done1;
    await delay(100);

    ws.send(JSON.stringify({ type: MSG_CHAT_CLEAR }));
    await delay(100);

    const done2 = waitForDone(ws, 10000);
    sendChatRequest(ws, [makeUserMessage("After clear")]);
    await done2;
    await delay(200);

    const messages = (await agent.getMessages()) as UIMessage[];
    expect(messages.length).toBe(2);

    await closeWS(ws);
  });

  it("latest: onChatResponse fires only for actual runs", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setSlowStreamMode(true, 100, 15);
    await agent.setMessageConcurrency("latest");

    const request1 = sendChatRequest(ws, [makeUserMessage("First")]);
    const done1 = waitForDoneId(ws, request1, 10000);
    await waitForActiveTurn(agent);
    sendChatRequest(ws, [makeUserMessage("Second")]);
    sendChatRequest(ws, [makeUserMessage("Third")]);
    await waitForOverlappingSubmits(agent, 2);

    await done1;
    await waitForDone(ws, 10000);
    await delay(200);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.every((r: ChatResponseResult) => r.status === "completed")).toBe(
      true
    );

    await closeWS(ws);
  });

  it("drop: onChatResponse fires only for accepted turn", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const { ws } = await connectWS(room);
    await collectMessages(ws, 3);

    await agent.setSlowStreamMode(true, 100, 15);
    await agent.setMessageConcurrency("drop");

    const request1 = sendChatRequest(ws, [makeUserMessage("First")]);
    const done1 = waitForDoneId(ws, request1, 10000);
    await waitForActiveTurn(agent);
    const request2 = sendChatRequest(ws, [makeUserMessage("Second")]);
    await waitForDoneId(ws, request2, 3000);

    await done1;
    await delay(500);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.length).toBe(1);

    await closeWS(ws);
  });
});

describe("repairInterruptedToolPart override (#1631)", () => {
  it("converts an interrupted ask_user into a text part carrying the prompt", async () => {
    const agent = await freshAgent();
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-ask_user",
            toolCallId: "tc1",
            state: "input-available",
            input: { prompt: "Ship it tonight?" }
          }
        ]
      }
    ] as unknown as UIMessage[];

    const repaired = await agent.repairToolTranscriptPartsForTest(messages);
    const part = (repaired[1] as UIMessage).parts[0] as Record<string, unknown>;
    // The client-resolved question is preserved as prose, not flipped to a
    // generic errored tool result.
    expect(part.type).toBe("text");
    expect(part.text).toBe("Ship it tonight?");
  });

  it("falls back to the default errored-result repair for non-ask_user tools", async () => {
    const agent = await freshAgent();
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-client_action",
            toolCallId: "tc1",
            state: "input-available",
            input: {}
          }
        ]
      }
    ] as unknown as UIMessage[];

    const repaired = await agent.repairToolTranscriptPartsForTest(messages);
    const part = (repaired[0] as UIMessage).parts[0] as Record<string, unknown>;
    expect(part.type).toBe("tool-client_action");
    expect(part.state).toBe("output-error");
  });

  it("leaves a settled ask_user untouched (only interrupted calls are repaired)", async () => {
    const agent = await freshAgent();
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-ask_user",
            toolCallId: "tc1",
            state: "output-available",
            input: { prompt: "Q?" },
            output: { answer: "yes" }
          }
        ]
      }
    ] as unknown as UIMessage[];

    const repaired = await agent.repairToolTranscriptPartsForTest(messages);
    const part = (repaired[0] as UIMessage).parts[0] as Record<string, unknown>;
    expect(part.type).toBe("tool-ask_user");
    expect(part.state).toBe("output-available");
  });
});
