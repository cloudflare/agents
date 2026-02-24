import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { getAgentByName } from "agents";

/**
 * Helper: connect to the SlowStreamAgent
 */
function connectSlowStream(room: string) {
  return connectChatWS(`/agents/slow-stream-agent/${room}`);
}

/**
 * Helper: send a chat request with custom body fields
 */
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

/**
 * Helper: send a cancel request
 */
function sendCancel(ws: WebSocket, requestId: string) {
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      id: requestId
    })
  );
}

/**
 * Helper: collect messages from a WebSocket until a done message arrives or timeout
 */
function collectMessages(
  ws: WebSocket,
  timeoutMs = 5000
): Promise<{ messages: unknown[]; timedOut: boolean }> {
  const messages: unknown[] = [];
  let resolve: (value: { messages: unknown[]; timedOut: boolean }) => void;
  const promise = new Promise<{ messages: unknown[]; timedOut: boolean }>(
    (r) => {
      resolve = r;
    }
  );

  const timeout = setTimeout(() => {
    ws.removeEventListener("message", handler);
    resolve({ messages, timedOut: true });
  }, timeoutMs);

  function handler(e: MessageEvent) {
    const data = JSON.parse(e.data as string);
    messages.push(data);
    if (isUseChatResponseMessage(data) && data.done) {
      clearTimeout(timeout);
      ws.removeEventListener("message", handler);
      resolve({ messages, timedOut: false });
    }
  }

  ws.addEventListener("message", handler);
  return promise;
}

const userMessage: ChatMessage = {
  id: "msg1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
};

describe("Cancel request", () => {
  it("cancel during plaintext streaming sends done and stops chunks", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    await new Promise((r) => setTimeout(r, 50));

    const requestId = "req-cancel-plain";

    // Start collecting messages
    const collecting = collectMessages(ws);

    // Send a slow plaintext streaming request (20 chunks × 50ms = ~1s total)
    sendChatRequest(ws, requestId, [userMessage], {
      format: "plaintext",
      chunkCount: 20,
      chunkDelayMs: 50
    });

    // Wait for a couple of chunks to arrive, then cancel
    await new Promise((r) => setTimeout(r, 200));
    sendCancel(ws, requestId);

    const { messages, timedOut } = await collecting;
    expect(timedOut).toBe(false);

    // Should have received a done message
    const chatResponses = messages.filter(isUseChatResponseMessage);
    const doneMsg = chatResponses.find((m) => m.done === true);
    expect(doneMsg).toBeDefined();

    // Should NOT have received all 20 chunks worth of text-delta events
    // (we cancelled after ~200ms, which is ~4 chunks at 50ms each)
    const textDeltas = chatResponses.filter((m) => {
      if (!m.body || typeof m.body !== "string" || m.body.length === 0)
        return false;
      try {
        const parsed = JSON.parse(m.body);
        return parsed.type === "text-delta";
      } catch {
        return false;
      }
    });
    expect(textDeltas.length).toBeLessThan(20);

    ws.close(1000);
  });

  it("cancel during SSE streaming sends done and stops chunks", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    await new Promise((r) => setTimeout(r, 50));

    const requestId = "req-cancel-sse";

    const collecting = collectMessages(ws);

    sendChatRequest(ws, requestId, [userMessage], {
      format: "sse",
      chunkCount: 20,
      chunkDelayMs: 50
    });

    // Wait for some chunks then cancel
    await new Promise((r) => setTimeout(r, 200));
    sendCancel(ws, requestId);

    const { messages, timedOut } = await collecting;
    expect(timedOut).toBe(false);

    // Should have received a done message
    const chatResponses = messages.filter(isUseChatResponseMessage);
    const doneMsg = chatResponses.find((m) => m.done === true);
    expect(doneMsg).toBeDefined();

    // Should have fewer chunks than a full stream
    const dataChunks = chatResponses.filter(
      (m) => m.body && typeof m.body === "string" && m.body.length > 0
    );
    expect(dataChunks.length).toBeLessThan(20);

    ws.close(1000);
  });

  it("abort controller is cleaned up after cancel", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    await new Promise((r) => setTimeout(r, 50));

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    const requestId = "req-cancel-cleanup";
    const collecting = collectMessages(ws);

    sendChatRequest(ws, requestId, [userMessage], {
      format: "plaintext",
      chunkCount: 20,
      chunkDelayMs: 50
    });

    await new Promise((r) => setTimeout(r, 200));
    sendCancel(ws, requestId);

    await collecting;

    // Allow cleanup to complete
    await new Promise((r) => setTimeout(r, 200));

    const count = await agentStub.getAbortControllerCount();
    expect(count).toBe(0);

    ws.close(1000);
  });

  it("cancel with abortSignal wired to stream stops faster", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    await new Promise((r) => setTimeout(r, 50));

    const requestId = "req-cancel-with-signal";
    const collecting = collectMessages(ws);

    sendChatRequest(ws, requestId, [userMessage], {
      format: "plaintext",
      useAbortSignal: true,
      chunkCount: 20,
      chunkDelayMs: 50
    });

    await new Promise((r) => setTimeout(r, 200));
    sendCancel(ws, requestId);

    const { messages, timedOut } = await collecting;
    expect(timedOut).toBe(false);

    // Should have received done
    const chatResponses = messages.filter(isUseChatResponseMessage);
    const doneMsg = chatResponses.find((m) => m.done === true);
    expect(doneMsg).toBeDefined();

    // Abort controller should be cleaned up
    await new Promise((r) => setTimeout(r, 200));
    const agentStub = await getAgentByName(env.SlowStreamAgent, room);
    const count = await agentStub.getAbortControllerCount();
    expect(count).toBe(0);

    ws.close(1000);
  });

  it("completing a full stream without cancel produces no abort-related issues", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    await new Promise((r) => setTimeout(r, 50));

    const requestId = "req-no-cancel";
    const collecting = collectMessages(ws);

    // Send a fast request that completes naturally
    sendChatRequest(ws, requestId, [userMessage], {
      format: "plaintext",
      chunkCount: 3,
      chunkDelayMs: 10
    });

    const { messages, timedOut } = await collecting;
    expect(timedOut).toBe(false);

    // Should have received all chunks + done
    const chatResponses = messages.filter(isUseChatResponseMessage);
    const doneMsg = chatResponses.find((m) => m.done === true);
    expect(doneMsg).toBeDefined();

    // Should have all 3 text-delta events
    const textDeltas = chatResponses.filter((m) => {
      if (!m.body || typeof m.body !== "string" || m.body.length === 0)
        return false;
      try {
        const parsed = JSON.parse(m.body);
        return parsed.type === "text-delta";
      } catch {
        return false;
      }
    });
    expect(textDeltas.length).toBe(3);

    // Abort controller should be cleaned up
    await new Promise((r) => setTimeout(r, 100));
    const agentStub = await getAgentByName(env.SlowStreamAgent, room);
    const count = await agentStub.getAbortControllerCount();
    expect(count).toBe(0);

    ws.close(1000);
  });
});
