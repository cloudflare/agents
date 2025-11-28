import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { type Env } from "./worker";
import { MessageType } from "../ai-types";
import type { UIMessage as ChatMessage } from "ai";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

async function connectChatWS(path: string) {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws, ctx };
}

function createChatRequest(id: string, messages: ChatMessage[]) {
  return JSON.stringify({
    type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
    id,
    init: {
      method: "POST",
      body: JSON.stringify({ messages })
    }
  });
}

function createUserMessage(id: string, text: string): ChatMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }]
  };
}

describe("Chat Message Batching (batch mode)", () => {
  it("batches multiple rapid messages and processes only the latest one", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const receivedResponses: string[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    // Wait for only 1 response (the combined/latest one)
    const timeout = setTimeout(() => resolvePromise(false), 3000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        receivedResponses.push(data.id);
        clearTimeout(timeout);
        // Give a bit more time to ensure no extra responses come in
        setTimeout(() => resolvePromise(true), 500);
      }
    });

    // Wait for connection to be fully established
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Send 3 messages with small delays (well within 300ms debounce window)
    // This ensures deterministic behavior - all messages arrive before timer fires
    const msg1 = createUserMessage("msg1", "First message");
    const msg2 = createUserMessage("msg2", "Second message");
    const msg3 = createUserMessage("msg3", "Third message");

    ws.send(createChatRequest("req1", [msg1]));
    await new Promise((resolve) => setTimeout(resolve, 20)); // 20ms << 300ms debounce
    ws.send(createChatRequest("req2", [msg1, msg2]));
    await new Promise((resolve) => setTimeout(resolve, 20)); // 40ms total << 300ms
    ws.send(createChatRequest("req3", [msg1, msg2, msg3]));

    const done = await donePromise;
    expect(done).toBe(true);

    // Only the last request should have been processed
    expect(receivedResponses).toEqual(["req3"]);

    ws.close();
  });

  it("clears pending request when chat is cleared", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    // Wait for initial connection messages
    await new Promise((resolve) => setTimeout(resolve, 100));

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));

    // Send a message first so there's something to clear
    const msg1 = createUserMessage("msg1", "Test message");
    ws.send(createChatRequest("req1", [msg1]));

    // Wait for debounce and response
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Clear the chat
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_CLEAR
      })
    );

    // Wait for clear to process
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Check that there's no pending request
    const hasPending = (await agentStub.hasPendingChatRequest()) as boolean;
    expect(hasPending).toBe(false);

    // Check that there's no processing timer
    const hasTimer = (await agentStub.hasProcessingTimer()) as boolean;
    expect(hasTimer).toBe(false);

    // Check that messages are cleared
    const messages = (await agentStub.getPersistedMessages()) as ChatMessage[];
    expect(messages.length).toBe(0);

    ws.close();
  });

  it("cancels pending request when cancelled", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    // Wait for initial connection messages
    await new Promise((resolve) => setTimeout(resolve, 100));

    const agentStub = env.TestChatAgent.get(env.TestChatAgent.idFromName(room));

    // Send a message (it will be pending during debounce)
    const msg1 = createUserMessage("msg1", "First message");
    ws.send(createChatRequest("req1", [msg1]));

    // Immediately cancel it (before debounce fires)
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
        id: "req1"
      })
    );

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check that there's no pending request
    const hasPending = (await agentStub.hasPendingChatRequest()) as boolean;
    expect(hasPending).toBe(false);

    ws.close();
  });

  it("processes new messages that arrive during response streaming", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const receivedResponses: string[] = [];
    let responseCount = 0;
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 5000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        responseCount++;
        receivedResponses.push(data.id);
        // Expect 2 responses total
        if (responseCount >= 2) {
          clearTimeout(timeout);
          resolvePromise(true);
        }
      }
    });

    // Send first message
    const msg1 = createUserMessage("msg1", "First message");
    ws.send(createChatRequest("req1", [msg1]));

    // Wait for the debounce to fire and first response to start
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Send second message while first is being processed
    const msg2 = createUserMessage("msg2", "Second message");
    ws.send(createChatRequest("req2", [msg1, msg2]));

    const done = await donePromise;
    expect(done).toBe(true);

    // Both requests should have been processed in order
    expect(receivedResponses).toContain("req1");
    expect(receivedResponses).toContain("req2");
    expect(receivedResponses.indexOf("req1")).toBeLessThan(
      receivedResponses.indexOf("req2")
    );

    ws.close();
  });

  it("handles messages from multiple connections with batching", async () => {
    const room = crypto.randomUUID();

    // Connect two clients to the same agent
    const { ws: ws1 } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: ws2 } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const allResponses: string[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    // We expect only 1 response since the second message should replace the first
    // during the debounce window (assuming they arrive within 300ms)
    const timeout = setTimeout(() => resolvePromise(false), 3000);

    const handleMessage = (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (
        data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        data.done === true
      ) {
        // Only add if not already in the list (both connections receive broadcasts)
        if (!allResponses.includes(data.id)) {
          allResponses.push(data.id);
        }
        clearTimeout(timeout);
        // Wait a bit to see if more responses come
        setTimeout(() => resolvePromise(true), 500);
      }
    };

    ws1.addEventListener("message", handleMessage);
    ws2.addEventListener("message", handleMessage);

    // Send messages from both connections rapidly
    const msg1 = createUserMessage("msg1", "From client 1");
    const msg2 = createUserMessage("msg2", "From client 2");

    ws1.send(createChatRequest("req-client1", [msg1]));
    ws2.send(createChatRequest("req-client2", [msg2]));

    const done = await donePromise;
    expect(done).toBe(true);

    // Only the last request should be processed (req-client2 replaced req-client1)
    expect(allResponses.length).toBe(1);
    expect(allResponses[0]).toBe("req-client2");

    ws1.close();
    ws2.close();
  });

  it("typing indicator delays processing", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const receivedResponses: string[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 3000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        receivedResponses.push(data.id);
        clearTimeout(timeout);
        setTimeout(() => resolvePromise(true), 200);
      }
    });

    // Send a message
    const msg1 = createUserMessage("msg1", "First message");
    ws.send(createChatRequest("req1", [msg1]));

    // Start "typing" - this should reset the timer to the shorter typing timeout
    await new Promise((resolve) => setTimeout(resolve, 100));
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_TYPING }));

    // Keep typing - each indicator resets the timer
    await new Promise((resolve) => setTimeout(resolve, 50));
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_TYPING }));

    // Send another message (simulating user finished typing and hit enter)
    const msg2 = createUserMessage("msg2", "Second message");
    ws.send(createChatRequest("req2", [msg1, msg2]));

    const done = await donePromise;
    expect(done).toBe(true);

    // Only the last request should be processed
    expect(receivedResponses).toEqual(["req2"]);

    ws.close();
  });

  it("idle timeout triggers if user doesn't type", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const receivedResponses: string[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        receivedResponses.push(data.id);
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    // Send a message and don't type anything after
    const msg1 = createUserMessage("msg1", "Message without typing");
    ws.send(createChatRequest("req1", [msg1]));

    // Wait for idle timeout (300ms in tests) + buffer
    const done = await donePromise;
    expect(done).toBe(true);

    expect(receivedResponses).toEqual(["req1"]);

    ws.close();
  });

  it("debounce timer resets when new messages arrive", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const receivedResponses: string[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 3000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        receivedResponses.push(data.id);
        clearTimeout(timeout);
        setTimeout(() => resolvePromise(true), 200);
      }
    });

    // Wait for connection to be fully established
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Send messages with small delays (well within 300ms debounce window)
    // Each message resets the timer, so only the last should be processed
    const msg1 = createUserMessage("msg1", "Message 1");
    const msg2 = createUserMessage("msg2", "Message 2");
    const msg3 = createUserMessage("msg3", "Message 3");

    ws.send(createChatRequest("req1", [msg1]));
    await new Promise((resolve) => setTimeout(resolve, 50)); // 50ms << 300ms debounce
    ws.send(createChatRequest("req2", [msg1, msg2]));
    await new Promise((resolve) => setTimeout(resolve, 50)); // 100ms total << 300ms
    ws.send(createChatRequest("req3", [msg1, msg2, msg3]));

    // The debounce should reset each time, so only req3 gets processed
    const done = await donePromise;
    expect(done).toBe(true);

    expect(receivedResponses).toEqual(["req3"]);

    ws.close();
  });
});
