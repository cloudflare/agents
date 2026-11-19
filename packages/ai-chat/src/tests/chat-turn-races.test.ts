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

  it("a tool result that arrives while the finished reply is being stored is applied", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);
    // The app's persistMessages awaits before it stores an assistant message.
    await agent.setPersistDelayForTest("assistant", 300);

    // Turn 1 streams a client tool call and finishes. Its reply has left the
    // stream and is not stored yet.
    sendChatRequest(ws, "req-tool", [user1], { clientToolCall: true });
    await waitUntil(() =>
      seen.some((m) => JSON.stringify(m).includes("tool-input-available"))
    );
    await delay(100);
    expect(await agent.getPersistedMessages()).toHaveLength(1);

    // The tab's tool finishes and its result arrives in that window.
    send(ws, toolResult("call-turn"));
    await waitUntil(() => responses(seen, "req-tool").some((m) => m.done));
    await delay(700);
    await agent.waitForIdleForTest();

    // The result is stored with the reply, and the model answers it.
    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(
      stored[1].parts.find(
        (part) => "toolCallId" in part && part.toolCallId === "call-turn"
      )
    ).toMatchObject({ state: "output-available", output: { ok: true } });
    expect(await agent.getChatMessageCallCountForTest()).toBe(2);
    ws.close(1000);
  });

  it("a tool result is answered after a message was appended without a turn", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);

    // Turn 1 ends on a client tool call.
    sendChatRequest(ws, "req-tool", [user1], { clientToolCall: true });
    await waitUntil(() => responses(seen, "req-tool").some((m) => m.done));
    await agent.waitForIdleForTest();
    const afterTurn = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(afterTurn.map((m) => m.role)).toEqual(["user", "assistant"]);

    // While the tool runs in the tab, the app appends a status message.
    // No turn stores it and none answers it.
    const note: ChatMessage = {
      id: "note-1",
      role: "assistant",
      parts: [{ type: "text", text: "Background job finished." }]
    };
    await agent.persistMessages([...afterTurn, note]);

    // The tool result arrives.
    send(ws, toolResult("call-turn"));
    await delay(300);
    await agent.waitForIdleForTest();

    // The model was asked again, and its answer is a new reply after the
    // note, which is left as it was.
    expect(await agent.getChatMessageCallCountForTest()).toBe(2);
    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant"
    ]);
    expect(stored[1].parts.at(-1)).toMatchObject({
      state: "output-available"
    });
    expect(stored[2]).toEqual(note);
    expect(stored[3].parts.some((part) => part.type === "text")).toBe(true);
    ws.close(1000);
  });

  it("a client tool result goes through the enqueue hook a subclass can wrap", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    await agent.persistMessages([
      user1,
      toolReply("assistant-hook", "call-hook")
    ]);

    send(ws, { ...toolResult("call-hook"), autoContinue: false });
    await waitUntil(async () => {
      const stored = (await agent.getPersistedMessages()) as ChatMessage[];
      return JSON.stringify(stored[1]).includes("output-available");
    });

    expect(await agent.getInteractionAppliesSeenForTest()).toBe(1);
    ws.close(1000);
  });

  it("a clear from another tab is not undone by a request whose messages are still being stored", async () => {
    const room = crypto.randomUUID();
    const { ws: tab1 } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: tab2 } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(tab1);
    const agent = await getAgentByName(env.TestChatAgent, room);
    const oldReply: ChatMessage = {
      id: "assistant-old",
      role: "assistant",
      parts: [{ type: "text", text: "An earlier answer" }]
    };
    await agent.persistMessages([user1, oldReply]);
    // The app's persistMessages awaits before it stores a user message.
    await agent.setPersistDelayForTest("user", 300);

    // Tab 1 sends a question with the history it has. The persist waits.
    sendChatRequest(tab1, "req-late", [user1, oldReply, user2]);
    await delay(100);
    // Tab 2 clears the chat.
    send(tab2, { type: MessageType.CF_AGENT_CHAT_CLEAR });
    await waitUntil(() => responses(seen, "req-late").some((m) => m.done));
    await delay(400);
    await agent.waitForIdleForTest();

    // The cleared history stays cleared, and the request ends as skipped
    // without calling the model.
    expect(await agent.getPersistedMessages()).toEqual([]);
    expect(responses(seen, "req-late").filter((m) => m.done)).toEqual([
      expect.objectContaining({ outcome: "skipped" })
    ]);
    expect(await agent.getChatMessageCallCountForTest()).toBe(0);
    tab1.close(1000);
    tab2.close(1000);
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
