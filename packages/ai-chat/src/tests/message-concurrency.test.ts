import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import type { ChatResponseResult } from "../";
import { MessageType, type OutgoingMessage } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectDebounceGap(
  firstStart: number | null,
  secondStart: number | null,
  minimumGapMs: number
) {
  expect(firstStart).not.toBeNull();
  expect(secondStart).not.toBeNull();

  if (firstStart === null || secondStart === null) {
    return;
  }

  const sortedStarts = [firstStart, secondStart].sort((a, b) => a - b);
  expect(sortedStarts[1] - sortedStarts[0]).toBeGreaterThanOrEqual(
    minimumGapMs
  );
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

function recordMessages(ws: WebSocket): OutgoingMessage[] {
  const seen: OutgoingMessage[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      seen.push(JSON.parse(event.data as string) as OutgoingMessage);
    } catch {
      // Ignore non-JSON messages.
    }
  });
  return seen;
}

function waitForDone(ws: WebSocket, requestId: string, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`Timed out waiting for done: ${requestId}`));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      const data = JSON.parse(event.data as string);
      if (
        isUseChatResponseMessage(data) &&
        data.id === requestId &&
        data.done
      ) {
        clearTimeout(timeout);
        ws.removeEventListener("message", onMessage);
        resolve();
      }
    }

    ws.addEventListener("message", onMessage);
  });
}

const firstUserMessage: ChatMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
};

const secondUserMessage: ChatMessage = {
  id: "user-2",
  role: "user",
  parts: [{ type: "text", text: "Second" }]
};

const thirdUserMessage: ChatMessage = {
  id: "user-3",
  role: "user",
  parts: [{ type: "text", text: "Third" }]
};

describe("AIChatAgent messageConcurrency", () => {
  it("latest runs only the newest overlapping submit while preserving queued user messages", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/latest-message-concurrency-agent/${room}`
    );
    await delay(50);

    const agentStub = await getAgentByName(
      env.LatestMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-latest-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 80
    });
    await delay(50);

    sendChatRequest(ws, "req-latest-2", [firstUserMessage, secondUserMessage], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 80
    });
    await delay(50);

    sendChatRequest(
      ws,
      "req-latest-3",
      [firstUserMessage, secondUserMessage, thirdUserMessage],
      {
        format: "plaintext",
        chunkCount: 8,
        chunkDelayMs: 80
      }
    );

    await waitUntil(async () => {
      const started = await agentStub.getStartedRequestIds();
      return started.length === 2;
    });
    await agentStub.waitForIdleForTest();

    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-latest-1",
      "req-latest-3"
    ]);

    const persistedMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];
    const userTexts = persistedMessages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        )
      );

    expect(userTexts).toEqual(
      expect.arrayContaining(["Hello", "Second", "Third"])
    );

    ws.close(1000);
  });

  it("drop rejects overlapping submits, sends rollback state, and never starts a second turn", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/drop-message-concurrency-agent/${room}`
    );
    await delay(50);

    const seenMessages = recordMessages(ws);
    const agentStub = await getAgentByName(
      env.DropMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-drop-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 50
    });
    await delay(40);

    sendChatRequest(ws, "req-drop-2", [firstUserMessage, secondUserMessage], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 50
    });

    await waitForDone(ws, "req-drop-2");
    await delay(50);

    expect(await agentStub.getStartedRequestIds()).toEqual(["req-drop-1"]);

    const rollbackMessage = [...seenMessages]
      .reverse()
      .find((message) => message.type === MessageType.CF_AGENT_CHAT_MESSAGES);
    expect(rollbackMessage).toBeDefined();
    if (rollbackMessage?.type === MessageType.CF_AGENT_CHAT_MESSAGES) {
      const rollbackTexts = rollbackMessage.messages.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        )
      );
      expect(rollbackTexts).not.toContain("Second");
    }

    await agentStub.waitForIdleForTest();

    const persistedMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];
    const userTexts = persistedMessages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        )
      );

    expect(userTexts).toEqual(["Hello"]);

    ws.close(1000);
  });

  it("merge concatenates overlapping queued user messages into one follow-up turn", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/merge-message-concurrency-agent/${room}`
    );
    await delay(50);

    const agentStub = await getAgentByName(
      env.MergeMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-merge-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 6,
      chunkDelayMs: 60
    });
    await delay(40);

    sendChatRequest(ws, "req-merge-2", [firstUserMessage, secondUserMessage], {
      format: "plaintext",
      chunkCount: 6,
      chunkDelayMs: 60
    });
    await delay(20);

    sendChatRequest(
      ws,
      "req-merge-3",
      [firstUserMessage, secondUserMessage, thirdUserMessage],
      {
        format: "plaintext",
        chunkCount: 6,
        chunkDelayMs: 60
      }
    );

    await waitUntil(async () => {
      const started = await agentStub.getStartedRequestIds();
      return started.length === 2;
    });
    await agentStub.waitForIdleForTest();

    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-merge-1",
      "req-merge-3"
    ]);

    const persistedMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];
    const userMessages = persistedMessages.filter(
      (message) => message.role === "user"
    );
    const userTexts = userMessages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
    );

    expect(userTexts).toEqual(
      expect.arrayContaining(["Hello", "Second\n\nThird"])
    );
    expect(userMessages).toHaveLength(2);

    ws.close(1000);
  });

  it("debounce waits for a quiet period and then runs only the latest submit", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/debounce-message-concurrency-agent/${room}`
    );
    await delay(50);

    const agentStub = await getAgentByName(
      env.DebounceMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-debounce-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 80
    });
    await delay(50);

    sendChatRequest(
      ws,
      "req-debounce-2",
      [firstUserMessage, secondUserMessage],
      {
        format: "plaintext",
        chunkCount: 8,
        chunkDelayMs: 80
      }
    );
    await delay(50);

    sendChatRequest(
      ws,
      "req-debounce-3",
      [firstUserMessage, secondUserMessage, thirdUserMessage],
      {
        format: "plaintext",
        chunkCount: 8,
        chunkDelayMs: 80
      }
    );

    await waitUntil(async () => {
      const started = await agentStub.getStartedRequestIds();
      return started.length === 2;
    });
    await agentStub.waitForIdleForTest();

    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-debounce-1",
      "req-debounce-3"
    ]);

    const firstStart = await agentStub.getRequestStartTime("req-debounce-1");
    const thirdStart = await agentStub.getRequestStartTime("req-debounce-3");
    expect(firstStart).not.toBeNull();
    expect(thirdStart).not.toBeNull();

    if (firstStart !== null && thirdStart !== null) {
      expect(thirdStart - firstStart).toBeGreaterThanOrEqual(80);
    }

    const persistedMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];
    const userTexts = persistedMessages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        )
      );

    expect(userTexts).toEqual(
      expect.arrayContaining(["Hello", "Second", "Third"])
    );

    ws.close(1000);
  });

  it("falls back to the default debounce window when debounceMs is omitted", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/missing-debounce-message-concurrency-agent/${room}`
    );
    await delay(50);

    const agentStub = await getAgentByName(
      env.MissingDebounceMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-missing-debounce-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 5,
      chunkDelayMs: 50
    });

    sendChatRequest(
      ws,
      "req-missing-debounce-2",
      [firstUserMessage, secondUserMessage],
      {
        format: "plaintext",
        chunkCount: 1,
        chunkDelayMs: 10
      }
    );

    await waitUntil(async () => {
      const started = await agentStub.getStartedRequestIds();
      return started.length === 2;
    }, 5000);
    await agentStub.waitForIdleForTest();

    const firstStart = await agentStub.getRequestStartTime(
      "req-missing-debounce-1"
    );
    const secondStart = await agentStub.getRequestStartTime(
      "req-missing-debounce-2"
    );

    expectDebounceGap(firstStart, secondStart, 700);

    ws.close(1000);
  });

  it("falls back to the default debounce window when debounceMs is invalid", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/invalid-debounce-message-concurrency-agent/${room}`
    );
    await delay(50);

    const agentStub = await getAgentByName(
      env.InvalidDebounceMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-invalid-debounce-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 5,
      chunkDelayMs: 50
    });

    sendChatRequest(
      ws,
      "req-invalid-debounce-2",
      [firstUserMessage, secondUserMessage],
      {
        format: "plaintext",
        chunkCount: 1,
        chunkDelayMs: 10
      }
    );

    await waitUntil(async () => {
      const started = await agentStub.getStartedRequestIds();
      return started.length === 2;
    }, 5000);
    await agentStub.waitForIdleForTest();

    const firstStart = await agentStub.getRequestStartTime(
      "req-invalid-debounce-1"
    );
    const secondStart = await agentStub.getRequestStartTime(
      "req-invalid-debounce-2"
    );

    expectDebounceGap(firstStart, secondStart, 700);

    ws.close(1000);
  });

  it("applies messageConcurrency only to submit-message requests, not regenerate", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/drop-message-concurrency-agent/${room}`
    );
    await delay(50);

    const agentStub = await getAgentByName(
      env.DropMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-regen-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 6,
      chunkDelayMs: 50
    });
    await delay(40);

    sendChatRequest(ws, "req-regen-2", [firstUserMessage], {
      trigger: "regenerate-message",
      format: "plaintext",
      chunkCount: 4,
      chunkDelayMs: 40
    });

    await waitUntil(async () => {
      const started = await agentStub.getStartedRequestIds();
      return started.length === 2;
    });
    await agentStub.waitForIdleForTest();

    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-regen-1",
      "req-regen-2"
    ]);

    ws.close(1000);
  });

  it("clear skips queued latest submits before they start", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/latest-message-concurrency-agent/${room}`
    );
    await delay(50);

    const agentStub = await getAgentByName(
      env.LatestMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-clear-1", [firstUserMessage], {
      format: "plaintext",
      useAbortSignal: true,
      chunkCount: 8,
      chunkDelayMs: 50
    });
    await delay(40);

    sendChatRequest(ws, "req-clear-2", [firstUserMessage, secondUserMessage], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 50
    });
    await delay(20);

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_CLEAR
      })
    );

    await waitForDone(ws, "req-clear-2");
    await agentStub.waitForIdleForTest();

    expect(await agentStub.getStartedRequestIds()).toEqual(["req-clear-1"]);

    const persistedMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];
    const userTexts = persistedMessages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        )
      );
    expect(userTexts).not.toContain("Second");

    ws.close(1000);
  });

  it("does not treat post-clear submits as overlapping with a stale epoch turn", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/drop-message-concurrency-agent/${room}`
    );
    await delay(50);

    const agentStub = await getAgentByName(
      env.DropMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-clear-stale-1", [firstUserMessage], {
      format: "plaintext",
      responseDelayMs: 300,
      chunkCount: 1,
      chunkDelayMs: 10
    });
    await delay(20);

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_CLEAR
      })
    );

    sendChatRequest(ws, "req-clear-stale-2", [secondUserMessage], {
      format: "plaintext",
      chunkCount: 1,
      chunkDelayMs: 10
    });

    await waitUntil(async () => {
      const persistedMessages =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      const userTexts = persistedMessages
        .filter((message) => message.role === "user")
        .flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "text" ? [part.text] : []
          )
        );

      return userTexts.includes("Second");
    }, 5000);
    await expect(
      agentStub.waitUntilStableForTest({ timeout: 15_000 })
    ).resolves.toBe(true);

    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-clear-stale-1",
      "req-clear-stale-2"
    ]);

    const persistedMessages =
      (await agentStub.getPersistedMessages()) as ChatMessage[];
    const userTexts = persistedMessages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        )
      );

    expect(userTexts).toContain("Second");

    ws.close(1000);
  });

  it("latest: onChatResponse fires only for the turn that actually runs, not superseded ones", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/latest-message-concurrency-agent/${room}`
    );
    await delay(50);

    const agentStub = await getAgentByName(
      env.LatestMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-resp-latest-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 6,
      chunkDelayMs: 60
    });
    await delay(40);

    sendChatRequest(
      ws,
      "req-resp-latest-2",
      [firstUserMessage, secondUserMessage],
      {
        format: "plaintext",
        chunkCount: 6,
        chunkDelayMs: 60
      }
    );
    await delay(20);

    sendChatRequest(
      ws,
      "req-resp-latest-3",
      [firstUserMessage, secondUserMessage, thirdUserMessage],
      {
        format: "plaintext",
        chunkCount: 6,
        chunkDelayMs: 60
      }
    );

    await waitUntil(async () => {
      const started = await agentStub.getStartedRequestIds();
      return started.length === 2;
    });
    await agentStub.waitForIdleForTest();

    const results =
      (await agentStub.getChatResponseResults()) as ChatResponseResult[];
    const resultRequestIds = results.map((r) => r.requestId);

    expect(resultRequestIds).toEqual([
      "req-resp-latest-1",
      "req-resp-latest-3"
    ]);
    expect(results.every((r) => r.status === "completed")).toBe(true);

    ws.close(1000);
  });

  it("drop: onChatResponse fires only for the accepted turn, not the dropped one", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/drop-message-concurrency-agent/${room}`
    );
    await delay(50);

    const agentStub = await getAgentByName(
      env.DropMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-resp-drop-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 50
    });
    await delay(40);

    sendChatRequest(
      ws,
      "req-resp-drop-2",
      [firstUserMessage, secondUserMessage],
      {
        format: "plaintext",
        chunkCount: 8,
        chunkDelayMs: 50
      }
    );

    await waitForDone(ws, "req-resp-drop-2");
    await agentStub.waitForIdleForTest();

    const results =
      (await agentStub.getChatResponseResults()) as ChatResponseResult[];
    const resultRequestIds = results.map((r) => r.requestId);

    expect(resultRequestIds).toEqual(["req-resp-drop-1"]);
    expect(results[0]).toMatchObject({ status: "completed" });

    ws.close(1000);
  });

  it("merge: onChatResponse fires once for the first turn and once for the merged turn", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/merge-message-concurrency-agent/${room}`
    );
    await delay(50);

    const agentStub = await getAgentByName(
      env.MergeMessageConcurrencyAgent,
      room
    );

    sendChatRequest(ws, "req-resp-merge-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 80
    });
    await delay(50);

    sendChatRequest(
      ws,
      "req-resp-merge-2",
      [firstUserMessage, secondUserMessage],
      {
        format: "plaintext",
        chunkCount: 8,
        chunkDelayMs: 80
      }
    );
    await delay(50);

    sendChatRequest(
      ws,
      "req-resp-merge-3",
      [firstUserMessage, secondUserMessage, thirdUserMessage],
      {
        format: "plaintext",
        chunkCount: 8,
        chunkDelayMs: 80
      }
    );

    await waitUntil(async () => {
      const started = await agentStub.getStartedRequestIds();
      return started.length === 2;
    });
    await agentStub.waitForIdleForTest();

    const results =
      (await agentStub.getChatResponseResults()) as ChatResponseResult[];
    const resultRequestIds = results.map((r) => r.requestId);

    expect(resultRequestIds).toEqual(["req-resp-merge-1", "req-resp-merge-3"]);
    expect(results.every((r) => r.status === "completed")).toBe(true);

    ws.close(1000);
  });

  it("queue: onChatResponse fires for every turn when messageConcurrency is queue", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/slow-stream-agent/${room}`);
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-resp-queue-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 3,
      chunkDelayMs: 30
    });
    await delay(20);

    sendChatRequest(
      ws,
      "req-resp-queue-2",
      [firstUserMessage, secondUserMessage],
      {
        format: "plaintext",
        chunkCount: 3,
        chunkDelayMs: 30
      }
    );

    await waitUntil(async () => {
      const started = await agentStub.getStartedRequestIds();
      return started.length === 2;
    });
    await agentStub.waitForIdleForTest();

    const results =
      (await agentStub.getChatResponseResults()) as ChatResponseResult[];
    const resultRequestIds = results.map((r) => r.requestId);

    expect(resultRequestIds).toEqual(["req-resp-queue-1", "req-resp-queue-2"]);
    expect(results.every((r) => r.status === "completed")).toBe(true);

    ws.close(1000);
  });
});
