import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";

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
});

// ── Client tool schemas ──────────────────────────────────────────

describe("Think — client tool schemas", () => {
  it("clientTools from chat request are passed to onChatMessage", async () => {
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
  it("deferred tool result runs after active continuation completes", async () => {
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

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-deferred-1",
        toolName: "client_action",
        output: "first done",
        autoContinue: true
      })
    );

    const firstDone = waitForDone(ws, 10000);
    await firstDone;
    await delay(100);

    ws.send(
      JSON.stringify({
        type: MSG_TOOL_RESULT,
        toolCallId: "tc-deferred-2",
        toolName: "client_action",
        output: "second done",
        autoContinue: true
      })
    );

    const secondDone = waitForDone(ws, 10000);
    await secondDone;

    const stored = await agent.getMessages();
    const assistantMessages = (stored as UIMessage[]).filter(
      (m: UIMessage) => m.role === "assistant"
    );
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2);

    await closeWS(ws);
  });
});
