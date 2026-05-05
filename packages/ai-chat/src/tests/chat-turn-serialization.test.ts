import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import { MessageType } from "../types";
import {
  connectChatWS,
  isUseChatResponseMessage,
  waitForChatClearBroadcast
} from "./test-utils";

function connectSlowStream(room: string) {
  return connectChatWS(`/agents/slow-stream-agent/${room}`);
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
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);
    const doneIds: string[] = [];

    ws.addEventListener("message", (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (isUseChatResponseMessage(data) && data.done) {
        doneIds.push(data.id);
      }
    });

    sendChatRequest(ws, "req-turn-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 100
    });

    await delay(60);

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

    await delay(100);

    expect(await agentStub.getStartedRequestIds()).toEqual(["req-turn-1"]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(true);

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
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    // ~1.6s total stream time. The "still streaming" assertions below fire
    // at t≈160ms and t≈260ms; this leaves >1s of headroom so the test
    // doesn't depend on the host meeting `chunkDelayMs` exactly under load.
    sendChatRequest(ws, "req-save-1", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 200
    });

    await delay(60);

    const savePromise = agentStub.saveSyntheticUserMessage(
      "Scheduled follow-up"
    );
    const waitForIdlePromise = agentStub.waitForIdleForTest();

    await delay(100);

    expect(await agentStub.getStartedRequestIds()).toEqual(["req-save-1"]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(true);
    await expect(
      Promise.race([
        waitForIdlePromise.then(() => "idle"),
        delay(100).then(() => "pending")
      ])
    ).resolves.toBe("pending");

    await savePromise;
    await waitForIdlePromise;

    const started = await agentStub.getStartedRequestIds();
    expect(started[0]).toBe("req-save-1");
    expect(started).toHaveLength(2);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);

    ws.close(1000);
  });

  it("abortActiveTurn aborts the current stream", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-abort-turn", [firstUserMessage], {
      format: "plaintext",
      useAbortSignal: true,
      chunkCount: 20,
      chunkDelayMs: 40
    });

    await delay(120);

    expect(await agentStub.isChatTurnActiveForTest()).toBe(true);
    expect(await agentStub.abortActiveTurnForTest()).toBe(true);

    await waitForDone(ws, "req-abort-turn");
    await agentStub.waitForIdleForTest();

    expect(await agentStub.getAbortControllerCount()).toBe(0);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);
    expect(await agentStub.abortActiveTurnForTest()).toBe(false);

    ws.close(1000);
  });

  it("waitForIdle covers tool-result continuations queued during an active turn", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-tool-turn", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 10,
      chunkDelayMs: 40
    });

    await delay(80);
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

    await delay(20);

    const idlePromise = agentStub.waitForIdleForTest();

    await expect(
      Promise.race([
        idlePromise.then(() => "idle"),
        delay(100).then(() => "pending")
      ])
    ).resolves.toBe("pending");

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
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-coalesced-tool-turn", [firstUserMessage], {
      format: "plaintext",
      chunkCount: 10,
      chunkDelayMs: 80
    });

    await delay(120);
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

    await delay(20);
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
    await delay(50);

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

    await delay(20);
    await agentStub.waitForIdleForTest();

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
  });

  it("queues a follow-up continuation when a tool result arrives after coalesce but before stream start", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-pre-stream-window", [firstUserMessage], {
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
    await agentStub.persistToolCallMessage(
      "assistant-pre-stream-tool-2",
      "call_pre_stream_tool_2",
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
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

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

    await delay(50);

    const clearBroadcast = waitForChatClearBroadcast(observerWs);
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await clearBroadcast;

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
    await delay(50);

    const agentStub = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-save-clear", [firstUserMessage], {
      format: "plaintext",
      useAbortSignal: true,
      chunkCount: 12,
      chunkDelayMs: 40
    });

    await delay(80);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(true);

    const savePromise = agentStub.saveSyntheticUserMessage(
      "This should be skipped"
    );

    await delay(20);

    const clearBroadcast = waitForChatClearBroadcast(observerWs);
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await clearBroadcast;

    await savePromise;
    await agentStub.waitForIdleForTest();

    const started = await agentStub.getStartedRequestIds();
    expect(started).toEqual(["req-save-clear"]);
    expect(await agentStub.isChatTurnActiveForTest()).toBe(false);

    ws.close(1000);
    observerWs.close(1000);
  });
});
