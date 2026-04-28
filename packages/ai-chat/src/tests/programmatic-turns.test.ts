import { env } from "cloudflare:workers";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { MessageType } from "../types";
import { connectChatWS, waitForChatClearBroadcast } from "./test-utils";

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
    const { ws: observerWs } = await connectSlowStream(room);
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

    const clearBroadcast = waitForChatClearBroadcast(observerWs);
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await clearBroadcast;

    const queuedResult = await queuedPromise;
    await agentStub.waitForIdleForTest();

    expect(queuedResult.status).toBe("skipped");
    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-programmatic-clear-1"
    ]);
    expect(await agentStub.getPersistedUserTexts()).toEqual([]);

    ws.close(1000);
    observerWs.close(1000);
  });
});

// ── External AbortSignal (issue #1406) ─────────────────────────
//
// `AIChatAgent.saveMessages` and `continueLastTurn` accept an
// `AbortSignal` via the `options.signal` argument. When the signal
// aborts, the result reports `status: "aborted"`. Pre-aborted signals
// short-circuit before any model work runs.

describe("AIChatAgent saveMessages — external AbortSignal", () => {
  it("returns 'completed' when the signal is never aborted", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    const result = await agentStub.testSaveMessagesWithSignal("Run normally", {
      body: { format: "plaintext", chunkCount: 2, chunkDelayMs: 10 }
    });

    expect(result.status).toBe("completed");
    expect(result.requestId).toBeTruthy();
  });

  it("returns 'aborted' when the signal is pre-aborted (no inference work runs)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    const result = await agentStub.testSaveMessagesWithSignal(
      "Cancel before run",
      {
        preAbort: true,
        body: {
          format: "plaintext",
          useAbortSignal: true,
          chunkCount: 30,
          chunkDelayMs: 50
        }
      }
    );

    expect(result.status).toBe("aborted");

    // Registry must be drained — the controller for this request id
    // was created (so getExistingSignal observers see consistent
    // state) and removed in the inner `finally` block.
    await delay(100);
    const count = await agentStub.getAbortControllerCount();
    expect(count).toBe(0);
  });

  it("returns 'aborted' when aborted mid-stream and persists partial chunks", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    const result = await agentStub.testSaveMessagesWithSignal("Long response", {
      abortAfterMs: 150,
      body: {
        format: "plaintext",
        useAbortSignal: true,
        chunkCount: 30,
        chunkDelayMs: 50
      }
    });

    expect(result.status).toBe("aborted");

    // Registry drains.
    await delay(100);
    const count = await agentStub.getAbortControllerCount();
    expect(count).toBe(0);
  });

  it("post-completion abort is a no-op (listener cleanup, no leaked controllers)", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    const result = await agentStub.testSaveMessagesWithSignal(
      "Run then abort",
      {
        abortAfterCompletion: true,
        body: { format: "plaintext", chunkCount: 1, chunkDelayMs: 5 }
      }
    );

    expect(result.status).toBe("completed");

    await delay(100);
    const count = await agentStub.getAbortControllerCount();
    expect(count).toBe(0);
  });

  it("public abortAllRequests() cancels a programmatic turn", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    const result = await agentStub.testSaveMessagesCancelledByAbortAllRequests(
      "Cancel via public method",
      150,
      {
        format: "plaintext",
        useAbortSignal: true,
        chunkCount: 30,
        chunkDelayMs: 50
      }
    );

    expect(result.status).toBe("aborted");
  });

  // Regression for issue #1406: if `runFiber` itself throws (e.g. SQLite
  // error inserting the fiber row) before invoking the chat-turn body,
  // the external-signal listener attached by `linkExternal` and the
  // registry entry created by `getSignal` must still be cleaned up.
  // Otherwise long-lived parent signals leak listeners across many
  // helper turns.
  it("cleans up external-signal listener and registry entry when runFiber throws", async () => {
    const room = crypto.randomUUID();
    const agentStub = await getAgentByName(env.RecoverySlowStreamAgent, room);

    const outcome = await agentStub.testSaveMessagesWithRunFiberFailure(
      "trigger run-fiber failure"
    );

    expect(outcome.threw).toBe(true);
    expect(outcome.abortRegistrySize).toBe(0);
    expect(outcome.listenerRemovedFromExternal).toBe(true);
  });
});
