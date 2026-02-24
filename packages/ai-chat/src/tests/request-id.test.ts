import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { getAgentByName } from "agents";

/**
 * Helper: send a chat request and wait for the done response.
 * Returns the request ID that was sent.
 */
async function sendChatAndWaitForDone(
  ws: WebSocket,
  requestId: string,
  messages: ChatMessage[],
  extraBody?: Record<string, unknown>
): Promise<void> {
  let resolvePromise: (value: boolean) => void;
  const donePromise = new Promise<boolean>((res) => {
    resolvePromise = res;
  });

  const timeout = setTimeout(() => resolvePromise(false), 2000);

  const handler = (e: MessageEvent) => {
    const data = JSON.parse(e.data as string);
    if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
      clearTimeout(timeout);
      resolvePromise(true);
    }
  };
  ws.addEventListener("message", handler);

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

  const done = await donePromise;
  ws.removeEventListener("message", handler);
  expect(done).toBe(true);

  // Allow handler to finish
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("requestId in OnChatMessageOptions", () => {
  it("should pass the client-sent request ID on initial chat messages", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.clearCapturedContext();

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    await sendChatAndWaitForDone(ws, "my-request-123", [userMessage]);

    const capturedId = await agentStub.getCapturedRequestId();
    expect(capturedId).toBe("my-request-123");

    ws.close(1000);
  });

  it("should pass a server-generated requestId on tool result continuation", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    // Step 1: Send initial request so context is established
    await sendChatAndWaitForDone(ws, "initial-req", [userMessage]);

    // Step 2: Persist a tool call in input-available state
    const toolCallId = "call_reqid_test";
    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId,
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Step 3: Clear captured state before continuation
    await agentStub.clearCapturedContext();

    // Step 4: Send tool result with autoContinue
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: { success: true },
        autoContinue: true
      })
    );

    // Wait for continuation (500ms stream wait + processing)
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Step 5: Verify a requestId was passed (server-generated, so just check it exists)
    const capturedId = await agentStub.getCapturedRequestId();
    expect(capturedId).toBeDefined();
    expect(typeof capturedId).toBe("string");
    expect(capturedId!.length).toBeGreaterThan(0);
    // Should NOT be the initial request ID — it's a new continuation ID
    expect(capturedId).not.toBe("initial-req");

    ws.close(1000);
  });

  it("should pass a server-generated requestId on tool approval continuation", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    // Step 1: Send initial request
    await sendChatAndWaitForDone(ws, "initial-req", [userMessage]);

    // Step 2: Persist a tool call in approval-required state
    const toolCallId = "call_approval_test";
    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId,
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Step 3: Clear captured state
    await agentStub.clearCapturedContext();

    // Step 4: Send approval with autoContinue
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_approval",
        toolCallId,
        approved: true,
        autoContinue: true
      })
    );

    // Wait for continuation
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Step 5: Verify requestId was passed
    const capturedId = await agentStub.getCapturedRequestId();
    expect(capturedId).toBeDefined();
    expect(typeof capturedId).toBe("string");
    expect(capturedId!.length).toBeGreaterThan(0);
    expect(capturedId).not.toBe("initial-req");

    ws.close(1000);
  });

  it("should tag response messages with requestId so the client can match them", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const receivedMessages: Array<{ id: string; done: boolean }> = [];

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (isUseChatResponseMessage(data)) {
        receivedMessages.push({ id: data.id, done: !!data.done });
      }
    });

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "tagged-req-42",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );

    // Wait for the done message
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (receivedMessages.some((m) => m.done)) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 2000);
    });

    // ALL response messages should be tagged with the same request ID
    expect(receivedMessages.length).toBeGreaterThan(0);
    for (const msg of receivedMessages) {
      expect(msg.id).toBe("tagged-req-42");
    }

    ws.close(1000);
  });

  it("should allow handlers to send error responses using requestId (pre-stream failure use case)", async () => {
    // This is the primary use case from the PR:
    // An onChatMessage handler validates the request body BEFORE starting a stream.
    // If validation fails, it needs the requestId to send a properly-tagged error
    // message that the client transport will accept (it filters by data.id === requestId).
    //
    // We test this by verifying that requestId is available and matches the
    // wire-protocol ID, so a handler *could* send:
    //   connection.send(JSON.stringify({
    //     type: "cf_agent_use_chat_response",
    //     id: options.requestId,
    //     body: "validation error",
    //     done: true,
    //     error: true
    //   }));

    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.clearCapturedContext();

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    const clientRequestId = "client-error-test-id";
    await sendChatAndWaitForDone(ws, clientRequestId, [userMessage]);

    // Verify the requestId received in onChatMessage matches exactly
    // what the client sent as data.id — this is the contract that lets
    // handlers send tagged error responses
    const capturedId = await agentStub.getCapturedRequestId();
    expect(capturedId).toBe(clientRequestId);

    ws.close(1000);
  });

  it("should pass requestId with different values across sequential requests", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agentStub = await getAgentByName(env.TestChatAgent, room);

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    // First request
    await agentStub.clearCapturedContext();
    await sendChatAndWaitForDone(ws, "req-alpha", [userMessage]);
    const firstId = await agentStub.getCapturedRequestId();
    expect(firstId).toBe("req-alpha");

    // Second request with different ID
    await agentStub.clearCapturedContext();
    await sendChatAndWaitForDone(ws, "req-beta", [userMessage]);
    const secondId = await agentStub.getCapturedRequestId();
    expect(secondId).toBe("req-beta");

    // They should be different
    expect(firstId).not.toBe(secondId);

    ws.close(1000);
  });
});
