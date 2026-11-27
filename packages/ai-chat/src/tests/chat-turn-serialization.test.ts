import { env } from "cloudflare:workers";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import { MessageType } from "../types";
import {
  connectChatWS,
  isUseChatResponseMessage,
  waitForChatClearBroadcast,
  waitUntilHandled
} from "./test-utils";

function connectSlowStream(room: string) {
  return connectChatWS(`/agents/slow-stream-agent/${room}`);
}

/** Bounds for waits on the agent, inside the 10 s test timeout. */
const BOUNDS = { timeout: 3_000, interval: 20 };

/** Hold `requestId`'s stream after its first chunk, and wait until held. */
async function holdStream(
  agent: {
    holdStreamForTest(id: string): Promise<void>;
    isStreamHeldForTest(id: string): Promise<boolean>;
    releaseStreamForTest(id: string): Promise<void>;
  },
  requestId: string,
  send: () => void
): Promise<void> {
  await agent.holdStreamForTest(requestId);
  onTestFinished(() => agent.releaseStreamForTest(requestId));
  send();
  await vi.waitFor(async () => {
    expect(await agent.isStreamHeldForTest(requestId)).toBe(true);
  }, BOUNDS);
}

/** Wait until `count` turns are queued, the running one included. */
async function queued(
  agent: { queuedTurnCountForTest(): Promise<number> },
  count: number
): Promise<void> {
  await vi.waitFor(async () => {
    expect(await agent.queuedTurnCountForTest()).toBe(count);
  }, BOUNDS);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
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

describe("AIChatAgent chat turn serialization", () => {
  it("queues a second websocket request behind the active turn", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);
    const doneIds: string[] = [];

    ws.addEventListener("message", (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (isUseChatResponseMessage(data) && data.done) {
        doneIds.push(data.id);
      }
    });

    await holdStream(agentStub, "req-turn-1", () =>
      sendChatRequest(ws, "req-turn-1", [firstUserMessage], {
        format: "plaintext",
        chunkCount: 8,
        chunkDelayMs: 100
      })
    );

    sendChatRequest(
      ws,
      "req-turn-2",
      [
        firstUserMessage,
        {
          id: "user-2",
          role: "user",
          parts: [{ type: "text", text: "Second" }]
        }
      ],
      {
        format: "plaintext",
        chunkCount: 8,
        chunkDelayMs: 100
      }
    );

    await queued(agentStub, 2);

    expect(await agentStub.getStartedRequestIds()).toEqual(["req-turn-1"]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(true);
    await agentStub.releaseStreamForTest("req-turn-1");

    await waitUntil(async () => {
      const started = await agentStub.getStartedRequestIds();
      return started.length === 2;
    });

    await agentStub.waitForIdleForTest();

    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-turn-1",
      "req-turn-2"
    ]);
    expect(doneIds.slice(0, 2)).toEqual(["req-turn-1", "req-turn-2"]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);

    ws.close(1000);
  });

  it("queues saveMessages behind the active turn and waitForIdle covers both turns", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    // The first request is held mid-stream while the save queues behind it.
    await holdStream(agentStub, "req-save-1", () =>
      sendChatRequest(ws, "req-save-1", [firstUserMessage], {
        format: "plaintext",
        chunkCount: 8,
        chunkDelayMs: 200
      })
    );

    const savePromise = agentStub.saveSyntheticUserMessage(
      "Scheduled follow-up"
    );
    const waitForIdlePromise = agentStub.waitForIdleForTest();

    await queued(agentStub, 2);

    expect(await agentStub.getStartedRequestIds()).toEqual(["req-save-1"]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(true);
    // The idle wait has not settled: a round trip to the agent, while the
    // turn is held, comes back first.
    let idleSettled = false;
    // Rejections are the awaited promise's to report, not this observer's.
    void waitForIdlePromise.then(
      () => {
        idleSettled = true;
      },
      () => {}
    );
    expect(await agentStub.isStreamHeldForTest("req-save-1")).toBe(true);
    expect(idleSettled).toBe(false);

    await agentStub.releaseStreamForTest("req-save-1");
    await savePromise;
    await waitForIdlePromise;

    const started = await agentStub.getStartedRequestIds();
    expect(started[0]).toBe("req-save-1");
    expect(started).toHaveLength(2);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);

    ws.close(1000);
  });

  it("waitForIdle covers tool-result continuations queued during an active turn", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    // The active turn waits on the model and writes no reply, so the tool
    // call message stays the latest one and its continuation still applies.
    // The model's response is held until the test releases it.
    await agentStub.holdNextResponseForTest();
    onTestFinished(() => agentStub.releaseResponseForTest());
    sendChatRequest(ws, "req-tool-turn", [firstUserMessage], {
      format: "sse",
      chunkCount: 0
    });

    await waitUntil(async () => await agentStub.isResponseHeldForTest());
    expect(await agentStub.isChatTurnActiveForTest()).toBe(true);

    await agentStub.persistToolCallMessage(
      "assistant-tool-1",
      "call_tool_1",
      "testTool"
    );

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "call_tool_1",
        toolName: "testTool",
        output: { result: "ok" },
        autoContinue: true
      })
    );

    await waitUntilHandled(agentStub, "cf_agent_tool_result", 1);

    let idleWhileHeld = false;
    const idlePromise = agentStub.waitForIdleForTest();
    void idlePromise.then(() => {
      idleWhileHeld = true;
    });
    // A round trip after the wait: the active turn is still held, so the
    // agent cannot be idle.
    expect(await agentStub.isResponseHeldForTest()).toBe(true);
    expect(idleWhileHeld).toBe(false);
    await agentStub.releaseResponseForTest();

    await idlePromise;

    const started = await agentStub.getStartedRequestIds();
    expect(started[0]).toBe("req-tool-turn");
    expect(started.length).toBeGreaterThanOrEqual(2);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);

    ws.close(1000);
  });

  it("coalesces rapid auto-continued tool results into a single continuation turn", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    // The active turn waits on the model and writes no reply, so the tool
    // call messages stay the latest ones.
    // Held until both results are in.
    await agentStub.holdNextResponseForTest();
    onTestFinished(() => agentStub.releaseResponseForTest());
    sendChatRequest(ws, "req-coalesced-tool-turn", [firstUserMessage], {
      format: "sse",
      chunkCount: 0
    });
    await vi.waitFor(async () => {
      expect(await agentStub.isResponseHeldForTest()).toBe(true);
    }, BOUNDS);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(true);

    await agentStub.persistToolCallMessage(
      "assistant-tool-1",
      "call_tool_1",
      "testTool"
    );
    await agentStub.persistToolCallMessage(
      "assistant-tool-2",
      "call_tool_2",
      "testTool"
    );

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_tool_1",
        toolName: "testTool",
        output: { result: "ok-1" },
        autoContinue: true
      })
    );
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_tool_2",
        toolName: "testTool",
        output: { result: "ok-2" },
        autoContinue: true
      })
    );

    await waitUntilHandled(agentStub, MessageType.CF_AGENT_TOOL_RESULT, 2);
    // Handling starts each update without awaiting it: both are applied
    // while the turn is still held.
    await vi.waitFor(async () => {
      expect(
        await agentStub.toolOutputsAppliedForTest([
          "call_tool_1",
          "call_tool_2"
        ])
      ).toBe(true);
    }, BOUNDS);
    await agentStub.releaseResponseForTest();
    await agentStub.waitForIdleForTest();

    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-coalesced-tool-turn",
      expect.any(String)
    ]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);

    ws.close(1000);
  });

  it("processes rapid auto-continued tool results when no turn is active", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    await agentStub.persistToolCallMessage(
      "assistant-idle-tool-1",
      "call_idle_tool_1",
      "testTool"
    );
    await agentStub.persistToolCallMessage(
      "assistant-idle-tool-2",
      "call_idle_tool_2",
      "testTool"
    );

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_idle_tool_1",
        toolName: "testTool",
        output: { result: "ok-1" },
        autoContinue: true
      })
    );
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_idle_tool_2",
        toolName: "testTool",
        output: { result: "ok-2" },
        autoContinue: true
      })
    );

    // The results arrive over the socket, not the RPC: wait until the agent
    // has handled both, then until their updates and continuations settle.
    await waitUntilHandled(agentStub, MessageType.CF_AGENT_TOOL_RESULT, 2);
    // Up to two continuation turns of the default 20 x 50 ms reply.
    expect(await agentStub.waitUntilStableForTest({ timeout: 10_000 })).toBe(
      true
    );
    await agentStub.waitForIdleForTest();

    // Both results are applied.
    const stored = (await agentStub.getPersistedMessages()) as ChatMessage[];
    for (const toolCallId of ["call_idle_tool_1", "call_idle_tool_2"]) {
      expect(
        stored
          .flatMap((message) => message.parts)
          .find(
            (part) => "toolCallId" in part && part.toolCallId === toolCallId
          )
      ).toMatchObject({ state: "output-available" });
    }

    // With no prior active turn the coalesce window (10ms) starts
    // immediately. Both results coalesce into 1 turn when the second
    // message arrives in time; under load the window may close first,
    // yielding 2 sequential turns. Both outcomes are correct — the
    // deterministic coalescing path is covered by the "into a single
    // continuation turn" test above which has an active turn holding
    // the queue open.
    const ids = await agentStub.getStartedRequestIds();
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.length).toBeLessThanOrEqual(2);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);

    ws.close(1000);
  }, 20_000);

  it("queues a follow-up continuation when a tool result arrives after coalesce but before stream start", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-pre-stream-window", [firstUserMessage], {
      // Client tools, so a turn start leaves their unanswered calls alone.
      clientTools: [{ name: "testTool" }],
      format: "plaintext",
      responseDelayMs: 120,
      chunkCount: 1,
      chunkDelayMs: 10
    });
    await waitForDone(ws, "req-pre-stream-window");

    await agentStub.persistToolCallMessage(
      "assistant-pre-stream-tool-1",
      "call_pre_stream_tool_1",
      "testTool"
    );

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_pre_stream_tool_1",
        toolName: "testTool",
        output: { result: "ok-1" },
        autoContinue: true
      })
    );

    await waitUntil(async () => {
      return (await agentStub.getStartedRequestIds()).length === 2;
    });

    // The continuation waits on the model; the next tool call lands and is
    // answered before its stream starts.
    await agentStub.persistToolCallMessage(
      "assistant-pre-stream-tool-2",
      "call_pre_stream_tool_2",
      "testTool"
    );
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_pre_stream_tool_2",
        toolName: "testTool",
        output: { result: "ok-2" },
        autoContinue: true
      })
    );

    await waitUntil(async () => {
      return (await agentStub.getStartedRequestIds()).length === 3;
    });
    await agentStub.waitForIdleForTest();

    expect(await agentStub.getStartedRequestIds()).toEqual([
      "req-pre-stream-window",
      expect.any(String),
      expect.any(String)
    ]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);

    ws.close(1000);
  });

  it("chat clear during active turn skips queued continuation", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    const { ws: observerWs } = await connectSlowStream(room);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    // The active turn stays active until the test releases its stream.
    await agentStub.holdStreamForTest("req-pre-clear");
    // Released however the test ends.
    onTestFinished(() => agentStub.releaseStreamForTest("req-pre-clear"));
    sendChatRequest(ws, "req-pre-clear", [firstUserMessage], {
      format: "plaintext",
      useAbortSignal: true,
      chunkCount: 12,
      chunkDelayMs: 40
    });

    await waitUntil(
      async () => (await agentStub.isChatTurnActiveForTest()) === true
    );

    await agentStub.persistToolCallMessage(
      "assistant-clear-tool",
      "call_clear_tool",
      "testTool"
    );

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "call_clear_tool",
        toolName: "testTool",
        output: { result: "ok" },
        autoContinue: true
      })
    );

    await waitUntilHandled(agentStub, "cf_agent_tool_result", 1);
    // The continuation is queued behind the active turn.
    await waitUntil(async () => {
      const state = await agentStub.getContinuationStateForTest();
      return state.hasPending || state.hasNext;
    });

    const clearBroadcast = waitForChatClearBroadcast(observerWs);
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await clearBroadcast;
    await agentStub.releaseStreamForTest("req-pre-clear");

    await agentStub.waitForIdleForTest();

    const started = await agentStub.getStartedRequestIds();
    expect(started).toEqual(["req-pre-clear"]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);

    ws.close(1000);
    observerWs.close(1000);
  });

  it("saveMessages queued behind active turn is skipped after clear", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    const { ws: observerWs } = await connectSlowStream(room);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    // The active turn stays active until the test releases its stream.
    await agentStub.holdStreamForTest("req-save-clear");
    onTestFinished(() => agentStub.releaseStreamForTest("req-save-clear"));
    sendChatRequest(ws, "req-save-clear", [firstUserMessage], {
      format: "plaintext",
      useAbortSignal: true,
      chunkCount: 12,
      chunkDelayMs: 40
    });

    await waitUntil(
      async () => await agentStub.isStreamHeldForTest("req-save-clear")
    );
    expect(await agentStub.isChatTurnActiveForTest()).toBe(true);

    const savePromise = agentStub.saveSyntheticUserMessage(
      "This should be skipped"
    );
    // The save waits in the queue behind the held turn.
    await waitUntil(
      async () => (await agentStub.queuedTurnCountForTest()) === 2
    );

    const clearBroadcast = waitForChatClearBroadcast(observerWs);
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await clearBroadcast;
    await agentStub.releaseStreamForTest("req-save-clear");

    await savePromise;
    await agentStub.waitForIdleForTest();

    const started = await agentStub.getStartedRequestIds();
    expect(started).toEqual(["req-save-clear"]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);

    ws.close(1000);
    observerWs.close(1000);
  });
});
