import { env } from "cloudflare:workers";
import { describe, it, expect, onTestFinished, vi } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import {
  connectChatWS,
  isUseChatResponseMessage,
  socketBarrier,
  waitUntilHandled
} from "./test-utils";
import { getAgentByName } from "agents";

/** Bounds for waits on the agent, inside the 10 s test timeout. */
const BOUNDS = { timeout: 5_000, interval: 20 };

/**
 * Cancel `requestId` mid-stream: its stream is held after its first chunk,
 * the cancel is handled, and then the stream may go on (and sees it).
 */
async function cancelMidStream(
  ws: WebSocket,
  room: string,
  requestId: string,
  send: () => void
): Promise<void> {
  const agent = await getAgentByName(env.SlowStreamAgent, room);
  await agent.holdStreamForTest(requestId);
  onTestFinished(() => agent.releaseStreamForTest(requestId));
  send();
  await vi.waitFor(async () => {
    expect(await agent.isStreamHeldForTest(requestId)).toBe(true);
  }, BOUNDS);
  sendCancel(ws, requestId);
  await waitUntilHandled(agent, MessageType.CF_AGENT_CHAT_REQUEST_CANCEL, 1);
  await agent.releaseStreamForTest(requestId);
}

/** Wait until the agent holds no abort controller. */
async function abortControllersCleared(room: string): Promise<void> {
  const agent = await getAgentByName(env.SlowStreamAgent, room);
  await vi.waitFor(async () => {
    expect(await agent.getAbortControllerCount()).toBe(0);
  }, BOUNDS);
}

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
  timeoutMs = 10000
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
  it("ends a cancelled request aborted when onChatMessage fails with the abort's reason", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    const requestId = "req-cancel-before-response";
    const collecting = collectMessages(ws);

    // `onChatMessage` waits on the turn's signal and rejects with its
    // reason, the way `await generateText({ abortSignal })` does.
    sendChatRequest(ws, requestId, [userMessage], {
      failOnAbort: "before-response"
    });
    await new Promise((r) => setTimeout(r, 200));
    sendCancel(ws, requestId);

    const { messages, timedOut } = await collecting;
    expect(timedOut).toBe(false);
    const frames = messages.filter(isUseChatResponseMessage);
    expect(frames.filter((frame) => frame.error)).toEqual([]);
    expect(frames.at(-1)).toMatchObject({
      id: requestId,
      done: true,
      outcome: "aborted"
    });
    const agent = await getAgentByName(env.SlowStreamAgent, room);
    expect(await agent.getOnErrorCallsForTest()).toEqual([]);
    ws.close(1000);
  });

  it.each([
    ["mid-stream", { format: "plaintext", chunkCount: 100, chunkDelayMs: 50 }],
    ["before its response", { failOnAbort: "before-response" }]
  ])(
    "sends the stopping tab one terminal frame for a request stopped %s",
    async (when, body) => {
      const room = crypto.randomUUID();
      const { ws } = await connectSlowStream(room);
      const requestId = "req-one-terminal";
      const terminals: unknown[] = [];
      ws.addEventListener("message", (e: MessageEvent) => {
        const data = JSON.parse(e.data as string);
        if (
          isUseChatResponseMessage(data) &&
          data.id === requestId &&
          data.done
        ) {
          terminals.push(data);
        }
      });

      const seen: unknown[] = [];
      ws.addEventListener("message", (e: MessageEvent) => {
        seen.push(JSON.parse(e.data as string));
      });
      const agent = await getAgentByName(env.SlowStreamAgent, room);

      sendChatRequest(ws, requestId, [userMessage], body);
      // The request's turn has started before the stop is sent; mid-stream,
      // its text has reached the tab too.
      await vi.waitFor(async () => {
        expect(await agent.getStartedRequestIds()).toContain(requestId);
      });
      if (when === "mid-stream") {
        await vi.waitFor(() =>
          expect(
            seen.some(
              (m) =>
                isUseChatResponseMessage(m) &&
                m.id === requestId &&
                typeof m.body === "string" &&
                m.body.includes('"text-delta"') &&
                !m.done
            )
          ).toBe(true)
        );
      }
      sendCancel(ws, requestId);
      // The stop's handler has finished, so all it sends is sent ...
      await waitUntilHandled(
        agent,
        MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
        1
      );
      await vi.waitFor(() => expect(terminals.length).toBeGreaterThan(0));
      // ... and by the barrier's reply it has arrived.
      await socketBarrier(ws, seen);

      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({ outcome: "aborted" });
      ws.close(1000);
    }
  );

  it("cancel during plaintext streaming sends done and stops chunks", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);

    const requestId = "req-cancel-plain";

    // Start collecting messages
    const collecting = collectMessages(ws);

    // Send a slow plaintext streaming request (100 chunks × 50ms = ~5s total)
    await cancelMidStream(ws, room, requestId, () =>
      sendChatRequest(ws, requestId, [userMessage], {
        format: "plaintext",
        chunkCount: 100,
        chunkDelayMs: 50
      })
    );

    const { messages, timedOut } = await collecting;
    expect(timedOut).toBe(false);

    // Should have received a done message
    const chatResponses = messages.filter(isUseChatResponseMessage);
    const doneMsg = chatResponses.find((m) => m.done === true);
    expect(doneMsg).toBeDefined();
    expect(doneMsg?.outcome).toBe("aborted");

    // Should NOT have received all 100 chunks worth of text-delta events
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
    expect(textDeltas.length).toBeLessThan(100);

    ws.close(1000);
  });

  it("cancel during SSE streaming sends done and stops chunks", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);

    const requestId = "req-cancel-sse";

    const collecting = collectMessages(ws);

    await cancelMidStream(ws, room, requestId, () =>
      sendChatRequest(ws, requestId, [userMessage], {
        format: "sse",
        chunkCount: 100,
        chunkDelayMs: 50
      })
    );

    const { messages, timedOut } = await collecting;
    expect(timedOut).toBe(false);

    // Should have received a done message
    const chatResponses = messages.filter(isUseChatResponseMessage);
    const doneMsg = chatResponses.find((m) => m.done === true);
    expect(doneMsg).toBeDefined();
    expect(doneMsg?.outcome).toBe("aborted");

    // Should have fewer chunks than a full stream
    const dataChunks = chatResponses.filter(
      (m) => m.body && typeof m.body === "string" && m.body.length > 0
    );
    expect(dataChunks.length).toBeLessThan(100);

    ws.close(1000);
  });

  it("abort controller is cleaned up after cancel", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);

    const requestId = "req-cancel-cleanup";
    const collecting = collectMessages(ws);

    await cancelMidStream(ws, room, requestId, () =>
      sendChatRequest(ws, requestId, [userMessage], {
        format: "plaintext",
        chunkCount: 100,
        chunkDelayMs: 50
      })
    );

    await collecting;

    await abortControllersCleared(room);

    ws.close(1000);
  });

  it("cancel with abortSignal wired to stream stops faster", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);

    const requestId = "req-cancel-with-signal";
    const collecting = collectMessages(ws);

    await cancelMidStream(ws, room, requestId, () =>
      sendChatRequest(ws, requestId, [userMessage], {
        format: "plaintext",
        useAbortSignal: true,
        chunkCount: 100,
        chunkDelayMs: 50
      })
    );

    const { messages, timedOut } = await collecting;
    expect(timedOut).toBe(false);

    // Should have received done
    const chatResponses = messages.filter(isUseChatResponseMessage);
    const doneMsg = chatResponses.find((m) => m.done === true);
    expect(doneMsg).toBeDefined();

    // Abort controller should be cleaned up
    await abortControllersCleared(room);

    ws.close(1000);
  });

  it("completing a full stream without cancel produces no abort-related issues", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);

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
    expect(doneMsg?.outcome).toBe("completed");

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
    await abortControllersCleared(room);

    ws.close(1000);
  });
});
