import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import type { ResponseResult } from "../";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { getAgentByName } from "agents";

function connectResponseAgent(room: string) {
  return connectChatWS(`/agents/response-agent/${room}`);
}

function sendChatRequest(
  ws: WebSocket,
  requestId: string,
  messages: ChatMessage[],
  extraBody?: Record<string, unknown>
) {
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: requestId,
      init: {
        method: "POST",
        body: JSON.stringify({ messages, ...extraBody })
      }
    })
  );
}

function waitForDone(
  ws: WebSocket,
  requestId?: string,
  timeoutMs = 5000
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    function handler(e: MessageEvent) {
      const data = JSON.parse(e.data as string);
      if (
        isUseChatResponseMessage(data) &&
        data.done &&
        (!requestId || data.id === requestId)
      ) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(true);
      }
    }
    ws.addEventListener("message", handler);
  });
}

function connectContinuationAgent(room: string) {
  return connectChatWS(`/agents/response-continuation-agent/${room}`);
}

function connectThrowingAgent(room: string) {
  return connectChatWS(`/agents/response-throwing-agent/${room}`);
}

const userMessage: ChatMessage = {
  id: "msg-1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
};

describe("onResponse hook", () => {
  it("fires with status=completed after a successful plaintext stream", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectResponseAgent(room);
    const done = waitForDone(ws, "req-1");

    sendChatRequest(ws, "req-1", [userMessage], {
      format: "plaintext",
      chunkCount: 3,
      chunkDelayMs: 10
    });

    expect(await done).toBe(true);
    await new Promise((r) => setTimeout(r, 100));

    const agentStub = await getAgentByName(env.ResponseAgent, room);
    const results = (await agentStub.getResponseResults()) as ResponseResult[];

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
    expect(results[0].continuation).toBe(false);
    expect(results[0].requestId).toBe("req-1");
    expect(results[0].message).toBeDefined();
    expect(results[0].message.role).toBe("assistant");

    ws.close(1000);
  });

  it("fires with status=completed after a successful SSE stream", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectResponseAgent(room);
    const done = waitForDone(ws, "req-sse");

    sendChatRequest(ws, "req-sse", [userMessage], {
      format: "sse",
      chunkCount: 3,
      chunkDelayMs: 10
    });

    expect(await done).toBe(true);
    await new Promise((r) => setTimeout(r, 100));

    const agentStub = await getAgentByName(env.ResponseAgent, room);
    const results = (await agentStub.getResponseResults()) as ResponseResult[];

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");

    ws.close(1000);
  });

  it("fires with status=error when the stream throws", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectResponseAgent(room);
    const done = waitForDone(ws, "req-err");

    sendChatRequest(ws, "req-err", [userMessage], {
      format: "plaintext",
      chunkCount: 6,
      chunkDelayMs: 10,
      throwError: true
    });

    expect(await done).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    const agentStub = await getAgentByName(env.ResponseAgent, room);
    const results = (await agentStub.getResponseResults()) as ResponseResult[];

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("error");
    expect(results[0].error).toBe("Simulated stream error");
    expect(results[0].requestId).toBe("req-err");

    ws.close(1000);
  });

  it("fires with status=aborted when the client cancels mid-stream", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectResponseAgent(room);
    const done = waitForDone(ws, "req-abort");

    // Don't pass useAbortSignal — we want the framework's reader.cancel()
    // to handle the abort, not the stream closing itself via controller.close()
    sendChatRequest(ws, "req-abort", [userMessage], {
      format: "plaintext",
      chunkCount: 40,
      chunkDelayMs: 50
    });

    await new Promise((r) => setTimeout(r, 200));

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
        id: "req-abort"
      })
    );

    expect(await done).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    const agentStub = await getAgentByName(env.ResponseAgent, room);
    const results = (await agentStub.getResponseResults()) as ResponseResult[];

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("aborted");
    expect(results[0].requestId).toBe("req-abort");

    ws.close(1000);
  });

  it("fires for saveMessages-initiated streams", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectResponseAgent(room);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.ResponseAgent, room);
    const done = waitForDone(ws);

    await agentStub.saveSyntheticUserMessage("trigger from saveMessages");
    expect(await done).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    const results = (await agentStub.getResponseResults()) as ResponseResult[];
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");

    ws.close(1000);
  });

  it("fires once per stream across multiple sequential requests", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectResponseAgent(room);

    for (let i = 0; i < 3; i++) {
      const reqId = `req-seq-${i}`;
      const done = waitForDone(ws, reqId);
      const messages: ChatMessage[] = [];
      for (let j = 0; j <= i; j++) {
        messages.push({
          id: `msg-seq-${j}`,
          role: "user",
          parts: [{ type: "text", text: `Message ${j}` }]
        });
      }

      sendChatRequest(ws, reqId, messages, {
        format: "plaintext",
        chunkCount: 2,
        chunkDelayMs: 5
      });
      expect(await done).toBe(true);
    }

    await new Promise((r) => setTimeout(r, 200));

    const agentStub = await getAgentByName(env.ResponseAgent, room);
    const results = (await agentStub.getResponseResults()) as ResponseResult[];

    expect(results).toHaveLength(3);
    expect(results.every((r: ResponseResult) => r.status === "completed")).toBe(
      true
    );
    expect(results[0].requestId).toBe("req-seq-0");
    expect(results[1].requestId).toBe("req-seq-1");
    expect(results[2].requestId).toBe("req-seq-2");

    ws.close(1000);
  });

  it("message in result has the finalized content", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectResponseAgent(room);
    const done = waitForDone(ws, "req-content");

    sendChatRequest(ws, "req-content", [userMessage], {
      format: "plaintext",
      chunkCount: 3,
      chunkDelayMs: 5
    });

    expect(await done).toBe(true);
    await new Promise((r) => setTimeout(r, 100));

    const agentStub = await getAgentByName(env.ResponseAgent, room);
    const results = (await agentStub.getResponseResults()) as ResponseResult[];

    expect(results).toHaveLength(1);
    const msg = results[0].message;
    const textParts = msg.parts.filter((p) => p.type === "text");
    expect(textParts.length).toBeGreaterThanOrEqual(1);

    const fullText = textParts
      .map((p) => ("text" in p ? (p.text as string) : ""))
      .join("");
    expect(fullText).toContain("chunk-0");
    expect(fullText).toContain("chunk-2");

    ws.close(1000);
  });
});

describe("onResponse with continuation", () => {
  it("fires with continuation=true after auto-continue from tool result", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectContinuationAgent(room);

    // Step 1: Send initial chat request to establish the agent
    const initialDone = waitForDone(ws, "req-init");
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-init",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );
    expect(await initialDone).toBe(true);

    // Step 2: Persist a tool call in input-available state
    const agentStub = await getAgentByName(env.ResponseContinuationAgent, room);
    const persistedMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];
    await agentStub.persistMessages([
      ...persistedMessages,
      {
        id: "assistant-tool",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId: "call_cont_test",
            state: "input-available",
            input: { query: "test" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Step 3: Send tool result with autoContinue=true
    const contDone = waitForDone(ws);
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "call_cont_test",
        toolName: "testTool",
        output: { result: "success" },
        autoContinue: true
      })
    );
    expect(await contDone).toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    // Step 4: Verify onResponse results
    const results = (await agentStub.getResponseResults()) as ResponseResult[];

    // Should have 2 results: initial request + continuation
    expect(results).toHaveLength(2);

    // First was the initial request (not a continuation)
    expect(results[0].continuation).toBe(false);
    expect(results[0].status).toBe("completed");

    // Second was the auto-continuation
    expect(results[1].continuation).toBe(true);
    expect(results[1].status).toBe("completed");

    ws.close(1000);
  });
});

describe("onResponse error resilience", () => {
  it("stream completes normally even when onResponse throws", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectThrowingAgent(room);

    // Send a normal chat request
    const done = waitForDone(ws, "req-throw-ok");
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-throw-ok",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );

    expect(await done).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    const agentStub = await getAgentByName(env.ResponseThrowingAgent, room);

    // onResponse was called (it set _streamCompleted before throwing)
    expect(await agentStub.getStreamCompleted()).toBe(true);

    // Message should still be persisted despite the hook throwing
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = persisted.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    // Agent should still be healthy — can handle another request
    const done2 = waitForDone(ws, "req-throw-ok-2");
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-throw-ok-2",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              userMessage,
              {
                id: "msg-2",
                role: "user",
                parts: [{ type: "text", text: "Still alive?" }]
              }
            ]
          })
        }
      })
    );
    expect(await done2).toBe(true);

    ws.close(1000);
  });

  it("onResponse throwing during error path does not mask the stream error", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectThrowingAgent(room);

    // Send a request that triggers a stream error
    const allMessages: unknown[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      allMessages.push(JSON.parse(e.data as string));
    });

    const done = waitForDone(ws, "req-throw-err");
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-throw-err",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage], throwError: true })
        }
      })
    );

    expect(await done).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    // Client should have received the error flag on the done message
    const errorDone = allMessages.find(
      (m) =>
        isUseChatResponseMessage(m) &&
        m.done === true &&
        m.id === "req-throw-err"
    ) as { error?: boolean } | undefined;
    expect(errorDone).toBeDefined();
    expect(errorDone!.error).toBe(true);

    // Agent should still be healthy
    const done2 = waitForDone(ws, "req-after-err");
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-after-err",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              userMessage,
              {
                id: "msg-3",
                role: "user",
                parts: [{ type: "text", text: "Recovered?" }]
              }
            ]
          })
        }
      })
    );
    expect(await done2).toBe(true);

    ws.close(1000);
  });
});

describe("Reader error propagation", () => {
  it("client receives error:true and message is NOT persisted on stream error", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectResponseAgent(room);

    const allMessages: unknown[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      allMessages.push(JSON.parse(e.data as string));
    });

    const done = waitForDone(ws, "req-reader-err");
    sendChatRequest(ws, "req-reader-err", [userMessage], {
      format: "plaintext",
      chunkCount: 6,
      chunkDelayMs: 10,
      throwError: true
    });

    expect(await done).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    // Client should see error:true on the done message
    const errorDone = allMessages.find(
      (m) =>
        isUseChatResponseMessage(m) &&
        m.done === true &&
        m.id === "req-reader-err"
    ) as { error?: boolean } | undefined;
    expect(errorDone).toBeDefined();
    expect(errorDone!.error).toBe(true);

    // The errored assistant message should NOT be persisted
    const agentStub = await getAgentByName(env.ResponseAgent, room);
    await agentStub.waitForIdleForTest();
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const assistantMessages = persisted.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(0);

    ws.close(1000);
  });
});

describe("onResponse fires outside turn lock", () => {
  it("saveMessages called from onResponse does not deadlock", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/response-save-messages-agent/${room}`
    );
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.ResponseSaveMessagesAgent, room);

    // Queue a single follow-up
    await agentStub.enqueueMessages(["Follow-up from onResponse"]);

    const done = waitForDone(ws, "req-hook-save");
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-hook-save",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );

    expect(await done).toBe(true);

    await agentStub.waitForIdleForTest();
    await new Promise((r) => setTimeout(r, 500));

    const results = (await agentStub.getResponseResults()) as ResponseResult[];

    // Drain loop fires onResponse for both the initial and the chained turn
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("completed");
    expect(results[1].status).toBe("completed");

    // Both the original and follow-up messages should be persisted
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const userMessages = persisted.filter((m) => m.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(2);

    ws.close(1000);
  });

  it("drain loop processes a multi-item queue without stalling", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/response-save-messages-agent/${room}`
    );
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.ResponseSaveMessagesAgent, room);

    // Queue 3 follow-up messages — the drain loop should process all of them
    await agentStub.enqueueMessages([
      "Queue item 1",
      "Queue item 2",
      "Queue item 3"
    ]);

    const done = waitForDone(ws, "req-drain");
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-drain",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );

    expect(await done).toBe(true);

    await agentStub.waitForIdleForTest();
    await new Promise((r) => setTimeout(r, 1000));

    const results = (await agentStub.getResponseResults()) as ResponseResult[];

    // 4 onResponse calls: initial + 3 queue items
    expect(results).toHaveLength(4);
    expect(results.every((r: ResponseResult) => r.status === "completed")).toBe(
      true
    );

    // All messages should be persisted
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
    const userMessages = persisted.filter((m) => m.role === "user");
    // Original + 3 follow-ups = 4
    expect(userMessages.length).toBe(4);

    const assistantMessages = persisted.filter((m) => m.role === "assistant");
    // 4 assistant responses (one per turn)
    expect(assistantMessages.length).toBe(4);

    ws.close(1000);
  });

  it("agent remains healthy after drain completes", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/response-save-messages-agent/${room}`
    );
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.ResponseSaveMessagesAgent, room);

    // Queue 1 follow-up
    await agentStub.enqueueMessages(["Chained item"]);

    const done = waitForDone(ws, "req-health");
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-health",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );
    expect(await done).toBe(true);

    await agentStub.waitForIdleForTest();
    await new Promise((r) => setTimeout(r, 500));

    // Agent should handle more requests after drain
    const done2 = waitForDone(ws, "req-after-drain");
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-after-drain",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              userMessage,
              {
                id: "msg-post-drain",
                role: "user",
                parts: [{ type: "text", text: "Still alive?" }]
              }
            ]
          })
        }
      })
    );
    expect(await done2).toBe(true);

    // This new request should also trigger onResponse
    await new Promise((r) => setTimeout(r, 200));
    const results = (await agentStub.getResponseResults()) as ResponseResult[];
    // 2 from drain chain + 1 from the new request = 3
    expect(results).toHaveLength(3);

    ws.close(1000);
  });
});
