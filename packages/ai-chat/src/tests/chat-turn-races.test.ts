import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import { MessageType, type OutgoingMessage } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

// Two tabs on one chat: orderings of send, regenerate, clear and tool results
// that a model check of the chat turn flow found. Each test runs one path's
// steps in order.

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function record(ws: WebSocket): OutgoingMessage[] {
  const seen: OutgoingMessage[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      seen.push(JSON.parse(event.data as string) as OutgoingMessage);
    } catch {
      // not JSON
    }
  });
  return seen;
}

function send(ws: WebSocket, frame: Record<string, unknown>) {
  ws.send(JSON.stringify(frame));
}

function sendChatRequest(
  ws: WebSocket,
  id: string,
  messages: ChatMessage[],
  body: Record<string, unknown> = {}
) {
  send(ws, {
    type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
    id,
    init: { method: "POST", body: JSON.stringify({ messages, ...body }) }
  });
}

function responses(seen: OutgoingMessage[], id: string) {
  return seen.filter(
    (
      m
    ): m is Extract<
      OutgoingMessage,
      { type: MessageType.CF_AGENT_USE_CHAT_RESPONSE }
    > => isUseChatResponseMessage(m) && m.id === id
  );
}

const user1: ChatMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
};

const user2: ChatMessage = {
  id: "user-2",
  role: "user",
  parts: [{ type: "text", text: "Something else" }]
};

function toolReply(id: string, toolCallId: string): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-testTool",
        toolCallId,
        state: "input-available",
        input: {}
      }
    ] as ChatMessage["parts"]
  };
}

function toolResult(toolCallId: string) {
  return {
    type: MessageType.CF_AGENT_TOOL_RESULT,
    toolCallId,
    toolName: "testTool",
    output: { ok: true },
    autoContinue: true
  };
}

describe("chat turn races", () => {
  it("a clear while the turn waits on the model keeps its reply out of the cleared chat", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/slow-stream-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.SlowStreamAgent, room);

    // Tab A sends the first question; the turn starts and waits on the
    // model (onChatMessage ignores its abortSignal).
    sendChatRequest(ws, "req-1", [user1], {
      format: "plaintext",
      responseDelayMs: 300,
      chunkCount: 3,
      chunkDelayMs: 10
    });
    await waitUntil(async () =>
      (await agent.getStartedRequestIds()).includes("req-1")
    );
    // A tab clears the chat; then the model answers.
    send(ws, { type: MessageType.CF_AGENT_CHAT_CLEAR });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.done));
    await agent.waitForIdleForTest();

    expect(await agent.getPersistedMessages()).toEqual([]);
    const frames = responses(seen, "req-1");
    expect(frames.filter((m) => m.body)).toEqual([]);
    expect(frames.filter((m) => m.done)).toEqual([
      expect.objectContaining({ outcome: "aborted" })
    ]);
    ws.close(1000);
  });

  it("a clear while the reply streams keeps the partial reply out of the cleared chat", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/slow-stream-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.SlowStreamAgent, room);

    // The turn streams its first chunk; then a tab clears the chat.
    sendChatRequest(ws, "req-1", [user1], {
      format: "plaintext",
      chunkCount: 50,
      chunkDelayMs: 30
    });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.body));
    send(ws, { type: MessageType.CF_AGENT_CHAT_CLEAR });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.done));
    await agent.waitForIdleForTest();

    expect(await agent.getPersistedMessages()).toEqual([]);
    ws.close(1000);
  });

  it("a regenerate from another tab while the reply streams leaves one reply", async () => {
    const room = crypto.randomUUID();
    const { ws: tabA } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const { ws: tabB } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const seen = record(tabA);
    const agent = await getAgentByName(env.SlowStreamAgent, room);

    // Tab A's turn streams its reply.
    sendChatRequest(tabA, "req-1", [user1], {
      format: "plaintext",
      chunkCount: 10,
      chunkDelayMs: 30
    });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.body));
    // Tab B regenerates that reply: it sends the transcript without it.
    send(tabB, {
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: "req-2",
      init: {
        method: "POST",
        body: JSON.stringify({
          messages: [user1],
          trigger: "regenerate-message",
          format: "plaintext",
          chunkCount: 2,
          chunkDelayMs: 10
        })
      }
    });
    // Tab A's reply finishes, then the regenerate's turn runs.
    await waitUntil(() => responses(seen, "req-2").some((m) => m.done), 6000);
    await agent.waitForIdleForTest();

    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
    tabA.close(1000);
    tabB.close(1000);
  });

  it("a regenerate waiting behind a reply never deletes a question sent after it", async () => {
    const room = crypto.randomUUID();
    const { ws: tabA } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const { ws: tabB } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const { ws: tabC } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const seen = record(tabA);
    const seenB = record(tabB);
    const agent = await getAgentByName(env.SlowStreamAgent, room);

    // Tab A's reply streams; tab B regenerates it, so B waits in the queue.
    sendChatRequest(tabA, "req-1", [user1], {
      format: "plaintext",
      chunkCount: 10,
      chunkDelayMs: 30
    });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.body));
    const beforeRegenerate = seen.length;
    send(tabB, {
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: "req-2",
      init: {
        method: "POST",
        body: JSON.stringify({
          messages: [user1],
          trigger: "regenerate-message",
          format: "plaintext",
          chunkCount: 2,
          chunkDelayMs: 10
        })
      }
    });
    // Tab B's request is admitted once its messages are broadcast to tab A.
    await waitUntil(() =>
      seen
        .slice(beforeRegenerate)
        .some((m) => m.type === MessageType.CF_AGENT_CHAT_MESSAGES)
    );
    // Tab C sends a new question while the regenerate waits.
    sendChatRequest(tabC, "req-3", [user1, user2], {
      format: "plaintext",
      chunkCount: 2,
      chunkDelayMs: 10
    });
    await waitUntil(() => responses(seen, "req-3").some((m) => m.done), 6000);
    await agent.waitForIdleForTest();

    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    // Both questions stay, each with one reply; the regenerate is skipped.
    expect(stored.filter((m) => m.role === "user").map((m) => m.id)).toEqual([
      "user-1",
      "user-2"
    ]);
    expect(stored.filter((m) => m.role === "assistant")).toHaveLength(2);
    expect(responses(seenB, "req-2").filter((m) => m.done)).toEqual([
      expect.objectContaining({ outcome: "skipped" })
    ]);
    tabA.close(1000);
    tabB.close(1000);
    tabC.close(1000);
  });

  it("a request cancelled in the queue ends on the tab that sent it", async () => {
    const room = crypto.randomUUID();
    const { ws: tabA } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const { ws: tabB } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const seenA = record(tabA);
    const seenB = record(tabB);
    const agent = await getAgentByName(env.SlowStreamAgent, room);

    // Tab A's first reply streams; its second request waits in the queue.
    sendChatRequest(tabA, "req-1", [user1], {
      format: "plaintext",
      chunkCount: 8,
      chunkDelayMs: 30
    });
    await waitUntil(() => responses(seenA, "req-1").some((m) => m.body));
    sendChatRequest(tabA, "req-2", [user1, user2], { format: "plaintext" });
    await waitUntil(async () =>
      ((await agent.getPersistedMessages()) as ChatMessage[]).some(
        (message) => message.id === user2.id
      )
    );

    // Tab A stops the queued request.
    send(tabA, { type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL, id: "req-2" });
    await waitUntil(() => responses(seenA, "req-2").some((m) => m.done));
    await agent.waitForIdleForTest();

    expect(responses(seenA, "req-2")).toEqual([
      expect.objectContaining({ done: true, outcome: "aborted" })
    ]);
    // Tab B was never shown that request, so it hears nothing about it.
    expect(responses(seenB, "req-2")).toEqual([]);
    expect(await agent.getStartedRequestIds()).toEqual(["req-1"]);
    tabA.close(1000);
    tabB.close(1000);
  });

  it("a request whose onChatMessage throws gets an error frame", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(
      `/agents/recovery-throwing-agent/${room}`
    );
    const seen = record(ws);
    const agent = await getAgentByName(env.RecoveryThrowingAgent, room);
    await agent.setShouldThrow(true);

    sendChatRequest(ws, "req-1", [user1]);
    await waitUntil(() => responses(seen, "req-1").some((m) => m.done));
    await agent.waitForIdleForTest();

    expect(responses(seen, "req-1")).toEqual([
      expect.objectContaining({
        done: true,
        error: true,
        body: "Simulated onChatMessage error"
      })
    ]);
    ws.close(1000);
  });

  it("a stopped reply's running server tool is stored as failed, and the chat does not wait on it", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);

    // The reply starts a server tool, which is still running when the user
    // presses stop.
    sendChatRequest(ws, "req-1", [user1], { serverToolThenHang: true });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.body));
    send(ws, { type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL, id: "req-1" });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.done));
    await agent.waitForIdleForTest();

    // Nothing will ever answer that call: it is stored with an error, not
    // left looking like it is running, and the chat is not waiting on anyone.
    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored.at(-1)?.parts.at(-1)).toMatchObject({
      toolCallId: "call-server-hang",
      state: "output-error"
    });
    expect(await agent.hasPendingInteractionForTest()).toBe(false);
    ws.close(1000);
  });

  it("a second tab's result for an answered tool call does not continue the reply again", async () => {
    const room = crypto.randomUUID();
    const { ws: tabA } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: tabB } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    // Turn 1 ended on a client tool call; both tabs run the tool.
    await agent.persistMessages([user1, toolReply("assistant-1", "call-1")]);

    // Tab A's result arrives and its continuation runs to the end.
    send(tabA, toolResult("call-1"));
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 1
    );
    await delay(100);
    await agent.waitForIdleForTest();
    const continued = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(continued[1].parts.length).toBe(2);

    // Tab B's result for the same call arrives.
    send(tabB, toolResult("call-1"));
    await delay(300);
    await agent.waitForIdleForTest();

    expect(await agent.getChatMessageCallCountForTest()).toBe(1);
    expect(await agent.getPersistedMessages()).toEqual(continued);
    tabA.close(1000);
    tabB.close(1000);
  });

  it("a new question settles the client tool call the earlier reply still waits on", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);
    const clientTools = [{ name: "testTool", description: "A client tool" }];
    // Turn 1 ended on a call to a tool the client sent a schema for. Nobody
    // has answered it.
    await agent.setClientToolsForTest(clientTools);
    await agent.persistMessages([user1, toolReply("assistant-1", "call-1")]);
    expect(await agent.hasPendingInteractionForTest()).toBe(true);

    // The user sends a new question instead of answering.
    sendChatRequest(
      ws,
      "req-2",
      [user1, toolReply("assistant-1", "call-1"), user2],
      { clientTools }
    );
    await waitUntil(() => responses(seen, "req-2").some((m) => m.done));
    await agent.waitForIdleForTest();

    // The model request held no call without a result (a provider rejects
    // one), and the call is stored as failed.
    expect(await agent.getChatMessageCallCountForTest()).toBe(1);
    expect(await agent.getUnansweredAtModelCallForTest()).toEqual([]);
    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored[1].parts[0]).toMatchObject({
      toolCallId: "call-1",
      state: "output-error"
    });
    expect(await agent.hasPendingInteractionForTest()).toBe(false);

    // A late answer changes nothing and continues nothing.
    send(ws, toolResult("call-1"));
    await delay(300);
    await agent.waitForIdleForTest();
    expect(await agent.getChatMessageCallCountForTest()).toBe(1);
    expect(
      ((await agent.getPersistedMessages()) as ChatMessage[])[1].parts[0]
    ).toMatchObject({ state: "output-error" });
    ws.close(1000);
  });

  it("a new question settles an approval the user never gave", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);
    const approval: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-testTool",
          toolCallId: "call-1",
          state: "approval-requested",
          input: {},
          approval: { id: "approval-1" }
        }
      ] as ChatMessage["parts"]
    };
    await agent.persistMessages([user1, approval]);

    sendChatRequest(ws, "req-2", [user1, approval, user2]);
    await waitUntil(() => responses(seen, "req-2").some((m) => m.done));
    await agent.waitForIdleForTest();

    expect(await agent.getUnansweredAtModelCallForTest()).toEqual([]);
    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored[1].parts[0]).toMatchObject({
      toolCallId: "call-1",
      state: "output-error"
    });
    ws.close(1000);
  });

  it("a tool result for an older reply does not continue the newer reply", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    // Turn 1 ended on a client tool call; before its result came back, a
    // second question was sent and answered.
    const reply2: ChatMessage = {
      id: "assistant-2",
      role: "assistant",
      parts: [{ type: "text", text: "Answer to the second question" }]
    };
    await agent.persistMessages([
      user1,
      toolReply("assistant-1", "call-1"),
      user2,
      reply2
    ]);

    // The tool result for turn 1's call arrives.
    send(ws, toolResult("call-1"));
    await delay(300);
    await agent.waitForIdleForTest();

    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored[1].parts[0]).toMatchObject({ state: "output-available" });
    expect(stored[3]).toEqual(reply2);
    expect(await agent.getChatMessageCallCountForTest()).toBe(0);
    ws.close(1000);
  });
});
