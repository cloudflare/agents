import { env } from "cloudflare:workers";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { MessageType } from "../types";
import { connectChatWS } from "./test-utils";

function connectSlowStream(room: string) {
  return connectChatWS(`/agents/slow-stream-agent/${room}`);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

const firstUserMessage: ChatMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
};

describe("AIChatAgent programmatic turns via saveMessages", () => {
  it("queues saveMessages behind an active websocket turn", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-programmatic-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 100
    });

    await delay(60);

    const queuedPromise = agentStub.enqueueSyntheticUserMessage(
      "Scheduled follow-up",
      {
        body: {
          format: "plaintext",
          chunkCount: 8,
          chunkDelayMs: 100
        }
      }
    );
    const waitForIdlePromise = agentStub.waitForIdleForTest();

    await delay(100);

    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-programmatic-1"
    ]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(true);

    await expect(
      Promise.race([
        waitForIdlePromise.then(() => "idle"),
        delay(100).then(() => "pending")
      ])
    ).resolves.toBe("pending");

    const queuedResult = await queuedPromise;
    await waitForIdlePromise;

    expect(queuedResult.status).toBe("completed");
    const startedIds = await agentStub.getStartedRequestIds();
    expect(startedIds).toHaveLength(2);
    expect(startedIds[0]).toBe("req-programmatic-1");
    expect(await agentStub.getPersistedUserTexts()).toEqual([
      "Hello",
      "Scheduled follow-up"
    ]);

    ws.close(1000);
  });

  it("evaluates queued programmatic messages against the latest transcript", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    agentStub.setTestBody({
      format: "plaintext",
      responseDelayMs: 100,
      chunkCount: 1,
      chunkDelayMs: 10
    });

    const [firstResult, secondResult] =
      await agentStub.enqueueSyntheticUserMessagesInOrder([
        { text: "First" },
        { text: "Second" }
      ]);

    await agentStub.waitForIdleForTest();

    expect(firstResult.status).toBe("completed");
    expect(secondResult.status).toBe("completed");
    expect(await agentStub.getStartedRequestIds()).toHaveLength(2);
    expect(await agentStub.getPersistedUserTexts()).toEqual([
      "First",
      "Second"
    ]);
  });

  it("marks queued programmatic turns as skipped after chat clear", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-programmatic-clear-1", [firstUserMessage], {
      format: "plaintext",
      useAbortSignal: true,
      chunkCount: 20,
      chunkDelayMs: 80
    });

    // Wait for the first request to be well underway before enqueuing
    // (stream runs for 20×80ms = 1600ms, so 200ms is ~12% in)
    await delay(200);

    const queuedPromise = agentStub.enqueueSyntheticUserMessage("Skipped", {
      body: {
        format: "plaintext",
        chunkCount: 8,
        chunkDelayMs: 100
      }
    });

    // Give the enqueue RPC time to be processed before sending clear
    await delay(100);

    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));

    const queuedResult = await queuedPromise;
    await agentStub.waitForIdleForTest();

    expect(queuedResult.status).toBe("skipped");
    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-programmatic-clear-1"
    ]);
    expect(await agentStub.getPersistedUserTexts()).toEqual([]);

    ws.close(1000);
  });
});
