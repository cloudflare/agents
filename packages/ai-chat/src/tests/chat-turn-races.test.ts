import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { getAgentByName } from "agents";
import { subscribe } from "agents/observability";
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

/** The text of every stored assistant message. */
function replyText(messages: unknown): string {
  return (messages as ChatMessage[])
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
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
    // The question waits behind the regenerate, which was sent first: the
    // regenerate replaces the first reply, then the question is stored and
    // answered. Both questions stay, each with one reply.
    expect(stored.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
    expect(stored.filter((m) => m.role === "user").map((m) => m.id)).toEqual([
      "user-1",
      "user-2"
    ]);
    const regenerated = responses(seenB, "req-2").filter((m) => m.done);
    expect(regenerated).toHaveLength(1);
    expect(regenerated[0].outcome ?? "completed").toBe("completed");
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
      ((await agent.getQueuedMessageIdsForTest()) as string[]).includes(
        user2.id
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

  // abortAllRequests() empties the abort registry. A reply that looked its
  // signal up there found none and streamed to the end.
  it("abortAllRequests() while a request waits on the model stops a reply that ignores its signal", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/slow-stream-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-1", [user1], {
      format: "plaintext",
      responseDelayMs: 300,
      chunkCount: 5,
      chunkDelayMs: 10
    });
    await waitUntil(
      async () => (await agent.getStartedRequestIds()).length === 1
    );
    await agent.abortAllRequestsForTest();
    await waitUntil(() => responses(seen, "req-1").some((m) => m.done));
    await agent.waitForIdleForTest();

    expect(replyText(await agent.getPersistedMessages())).toBe("");
    ws.close(1000);
  });

  it("abortAllRequests() while a continuation waits on the model stops a reply that ignores its signal", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/slow-stream-agent/${room}`);
    const agent = await getAgentByName(env.SlowStreamAgent, room);
    await agent.persistMessages([user1, toolReply("assistant-1", "call-1")]);
    await agent.setTestBody({
      format: "plaintext",
      responseDelayMs: 300,
      chunkCount: 5,
      chunkDelayMs: 10
    });

    send(ws, toolResult("call-1"));
    await waitUntil(
      async () => (await agent.getStartedRequestIds()).length === 1
    );
    await agent.abortAllRequestsForTest();
    await delay(500);
    await agent.waitForIdleForTest();

    expect(replyText(await agent.getPersistedMessages())).toBe("");
    ws.close(1000);
  });

  // A server-started turn runs with the tools and body stored when it
  // starts, like a continuation, not the ones stored when it was queued.
  it("a saveMessages turn queued behind a request runs with that request's body", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/slow-stream-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.SlowStreamAgent, room);

    sendChatRequest(ws, "req-1", [user1], {
      format: "plaintext",
      chunkCount: 6,
      chunkDelayMs: 50,
      marker: "first"
    });
    await waitUntil(
      async () => (await agent.getStartedRequestIds()).length === 1
    );
    // Queued behind req-1. Its body becomes the stored body when its turn
    // starts.
    sendChatRequest(ws, "req-2", [user1, user2], {
      format: "plaintext",
      chunkCount: 1,
      chunkDelayMs: 5,
      marker: "second"
    });
    await delay(50);
    // Called while the stored body is still req-1's.
    const queued = await agent.enqueueSyntheticUserMessage("Server follow-up");
    await waitUntil(() => responses(seen, "req-2").some((m) => m.done));
    await agent.waitForIdleForTest();

    expect(queued.status).toBe("completed");
    expect(await agent.getRequestBodyForTest(queued.requestId)).toMatchObject({
      marker: "second"
    });
    ws.close(1000);
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

  it("a tool result is stored, not continued, once a message was appended without a turn", async () => {
    const room = crypto.randomUUID();
    const dropped: string[] = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:continuation:dropped" && event.name === room) {
        dropped.push(event.payload.reason);
      }
    });
    try {
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
      const note: ChatMessage = {
        id: "note-1",
        role: "assistant",
        parts: [{ type: "text", text: "Background job finished." }]
      };
      await agent.persistMessages([...afterTurn, note]);

      // The tool result arrives. It is stored, and the conversation moved
      // on, so the model is not asked: the request would end in the note.
      send(ws, toolResult("call-turn"));
      await delay(300);
      await agent.waitForIdleForTest();

      expect(await agent.getChatMessageCallCountForTest()).toBe(1);
      const stored = (await agent.getPersistedMessages()) as ChatMessage[];
      expect(stored.map((m) => m.id)).toEqual([
        afterTurn[0].id,
        afterTurn[1].id,
        note.id
      ]);
      expect(stored[1].parts.at(-1)).toMatchObject({
        state: "output-available"
      });
      expect(stored[2]).toEqual(note);
      expect(dropped).toEqual(["moved_on"]);
      ws.close(1000);
    } finally {
      unsubscribe();
    }
  });

  it("a note after a reply does not let a continuation run over a call that still waits on the user", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);

    sendChatRequest(ws, "req-tool", [user1], { clientToolCall: true });
    await waitUntil(() => responses(seen, "req-tool").some((m) => m.done));
    await agent.waitForIdleForTest();
    const afterTurn = (await agent.getPersistedMessages()) as ChatMessage[];
    // The same reply also asked the user to approve a second call.
    const reply = {
      ...afterTurn[1],
      parts: [
        ...afterTurn[1].parts,
        {
          type: "tool-approveMe",
          toolCallId: "call-approval",
          state: "approval-requested",
          input: {},
          approval: { id: "approval-1" }
        }
      ]
    } as ChatMessage;
    const note: ChatMessage = {
      id: "note-1",
      role: "assistant",
      parts: [{ type: "text", text: "Background job finished." }]
    };
    await agent.persistMessages([afterTurn[0], reply, note]);

    send(ws, toolResult("call-turn"));
    await delay(400);
    await agent.waitForIdleForTest();

    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(await agent.getChatMessageCallCountForTest()).toBe(1);
    expect(stored[1].parts.at(-1)).toMatchObject({
      toolCallId: "call-approval",
      state: "approval-requested"
    });
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

  it("a clear while the finished reply is being stored does not bring the transcript back", async () => {
    const room = crypto.randomUUID();
    const { ws: tab1 } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: tab2 } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(tab1);
    const agent = await getAgentByName(env.TestChatAgent, room);

    sendChatRequest(tab1, "req-1", [user1]);
    await waitUntil(() => responses(seen, "req-1").some((m) => m.done));
    await agent.waitForIdleForTest();
    const afterFirst = (await agent.getPersistedMessages()) as ChatMessage[];

    // The app's persistMessages awaits before it stores the reply.
    await agent.setPersistDelayForTest("assistant", 300);
    sendChatRequest(tab1, "req-2", [...afterFirst, user2]);
    // Tab 2 clears the chat while the reply waits to be stored.
    await delay(150);
    send(tab2, { type: MessageType.CF_AGENT_CHAT_CLEAR });
    await delay(500);
    await agent.waitForIdleForTest();

    expect(await agent.getPersistedMessages()).toEqual([]);
    tab1.close(1000);
    tab2.close(1000);
  });

  it("a turn whose reply a clear kept out of storage does not report completed", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    // The app's persistMessages awaits before it stores the reply.
    await agent.setPersistDelayForTest("assistant", 300);

    const status = agent.saveUserMessageForTest("hello");
    await delay(150);
    send(ws, { type: MessageType.CF_AGENT_CHAT_CLEAR });

    expect(await status).not.toBe("completed");
    await agent.waitForIdleForTest();
    expect(await agent.getPersistedMessages()).toEqual([]);
    ws.close(1000);
  });

  it("a tab that was away when its request ended gets its done frame on resume", async () => {
    const room = crypto.randomUUID();
    const first = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    // The reply is stored after the tab went away.
    await agent.setPersistDelayForTest("assistant", 300);
    sendChatRequest(first.ws, "req-away", [user1]);
    await delay(100);
    first.ws.close(1000);
    await delay(500);
    await agent.waitForIdleForTest();

    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    send(ws, {
      type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST,
      probeId: "p1",
      requestIds: ["req-away"]
    });
    await waitUntil(() =>
      seen.some(
        (m) =>
          m.type === MessageType.CF_AGENT_STREAM_RESUMING &&
          "id" in m &&
          m.id === "req-away"
      )
    );
    send(ws, { type: MessageType.CF_AGENT_STREAM_RESUME_ACK, id: "req-away" });
    await waitUntil(() => responses(seen, "req-away").some((m) => m.done));
    ws.close(1000);
  });

  it("a persist that work started inside a turn's persist starts later is not held to that turn", async () => {
    const room = crypto.randomUUID();
    const { ws: tab1 } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: tab2 } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    await agent.storeNoteLaterFromPersistForTest(400);
    await agent.setPersistDelayForTest("user", 200);

    sendChatRequest(tab1, "req-1", [user1]);
    await delay(100);
    // The request is cleared before it is stored. The note the override
    // stores later is not part of that request.
    send(tab2, { type: MessageType.CF_AGENT_CHAT_CLEAR });
    await delay(600);
    await agent.waitForIdleForTest();

    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored.map((m) => m.id)).toEqual(["note-later"]);
    tab1.close(1000);
    tab2.close(1000);
  });

  it("a request from a tab a chunk behind does not shorten the stored reply", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);
    // A reply stopped mid-text. The server stored every chunk it streamed.
    const stored: ChatMessage = {
      id: "assistant-stopped",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "One, two, three", state: "streaming" }
      ]
    };
    await agent.persistMessages([user1, stored]);

    // The tab that pressed stop drew one chunk fewer, and sends that copy
    // with its next question.
    const behind: ChatMessage = {
      ...stored,
      parts: [
        { type: "step-start" },
        { type: "text", text: "One, two", state: "done" }
      ]
    };
    sendChatRequest(ws, "req-next", [user1, behind, user2]);
    await waitUntil(() => responses(seen, "req-next").some((m) => m.done));
    await agent.waitForIdleForTest();

    const after = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(after.slice(0, 3).map((m) => m.id)).toEqual([
      user1.id,
      "assistant-stopped",
      user2.id
    ]);
    expect(after[1].parts).toEqual(stored.parts);
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

  it("a continuation stopped while it waits in the queue never calls the model", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);
    await agent.persistMessages([user1, toolReply("assistant-1", "call-1")]);

    // Another turn holds the queue, so the continuation the tool result
    // fires has to wait behind it.
    await agent.holdTurnQueueForTest();
    send(ws, toolResult("call-1"));
    await waitUntil(
      async () => (await agent.pendingContinuationRequestIdForTest()) !== null
    );
    await delay(150);
    const continuationId = await agent.pendingContinuationRequestIdForTest();
    expect(continuationId).not.toBeNull();

    // A stop for the continuation arrives while it waits.
    send(ws, {
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      id: continuationId
    });
    await delay(50);
    await agent.releaseTurnQueueForTest();
    await agent.waitForIdleForTest();

    expect(await agent.getChatMessageCallCountForTest()).toBe(0);
    expect(await agent.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false
    });
    // The tab that was waiting on the continuation is told there is none.
    expect(
      seen.some((m) => m.type === MessageType.CF_AGENT_STREAM_RESUME_NONE)
    ).toBe(true);
    ws.close(1000);
  });

  it("a tab's stop while it waits for a continuation to start reaches the server", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);
    await agent.persistMessages([user1, toolReply("assistant-1", "call-1")]);

    await agent.holdTurnQueueForTest();
    send(ws, toolResult("call-1"));
    await waitUntil(
      async () => (await agent.pendingContinuationRequestIdForTest()) !== null
    );
    await delay(150);

    // The tab has no request id for the continuation yet: the transport
    // sends a cancel that names the continuation by its connection.
    send(ws, {
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      continuation: true
    });
    await delay(50);
    await agent.releaseTurnQueueForTest();
    await agent.waitForIdleForTest();

    expect(await agent.getChatMessageCallCountForTest()).toBe(0);
    expect(await agent.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false
    });
    expect(
      seen.some((m) => m.type === MessageType.CF_AGENT_STREAM_RESUME_NONE)
    ).toBe(true);
    ws.close(1000);
  });

  it("abortAllRequests() drops a continuation parked on an unanswered sibling, with no turn running", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    const reply = toolReply("assistant-1", "call-1");
    reply.parts.push({
      type: "tool-testTool",
      toolCallId: "call-2",
      state: "input-available",
      input: {}
    } as ChatMessage["parts"][number]);
    await agent.persistMessages([user1, reply]);

    // The first result asks to continue and parks on its sibling.
    send(ws, toolResult("call-1"));
    await waitUntil(
      async () => (await agent.pendingContinuationRequestIdForTest()) !== null
    );
    await delay(150);
    expect(await agent.getChatMessageCallCountForTest()).toBe(0);

    // The user stops everything. No turn is running.
    await agent.abortAllRequestsForTest();
    // The sibling answers later, without asking to continue.
    send(ws, { ...toolResult("call-2"), autoContinue: false });
    await delay(300);
    await agent.waitForIdleForTest();

    expect(await agent.getChatMessageCallCountForTest()).toBe(0);
    expect(await agent.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false
    });
    ws.close(1000);
  });

  it("a result that arrives while a continuation fails still reaches the model", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    // The reply ended on a client tool call, next to an approved call the
    // server has not run yet.
    const reply: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-testTool",
          toolCallId: "call-1",
          state: "input-available",
          input: {}
        },
        {
          type: "tool-otherTool",
          toolCallId: "call-2",
          state: "approval-responded",
          input: {},
          approval: { id: "approval-2", approved: true }
        }
      ] as ChatMessage["parts"]
    };
    await agent.persistMessages([user1, reply]);
    await agent.setTestBody({ delayMs: 300, failFirstContinuation: true });

    // The first result starts a continuation, which waits on the model.
    send(ws, toolResult("call-1"));
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 1
    );
    // A second result lands meanwhile. Then the model call fails.
    send(ws, toolResult("call-2"));
    await waitUntil(
      async () =>
        (await agent.getContinuationStateForTest()).hasDeferred === true
    );

    // The second result gets its own continuation.
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 2
    );
    await delay(400);
    await agent.waitForIdleForTest();
    expect(await agent.getChatMessageCallCountForTest()).toBe(2);
    expect(await agent.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false
    });
    ws.close(1000);
  });

  it("a continuation that fails before it streams is reported like any failed reply", async () => {
    const room = crypto.randomUUID();
    const observed: string[] = [];
    const unsubscribe = subscribe("message", (event) => {
      if (event.agent === "TestChatAgent" && event.name === room) {
        observed.push(event.type);
      }
    });
    try {
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      const seen = record(ws);
      const agent = await getAgentByName(env.TestChatAgent, room);
      await agent.persistMessages([user1, toolReply("assistant-1", "call-1")]);
      await agent.setTestBody({ failContinuations: true });

      send(ws, toolResult("call-1"));
      await waitUntil(() =>
        seen.some(
          (m) =>
            isUseChatResponseMessage(m) && m.error === true && m.done === true
        )
      );
      await agent.waitForIdleForTest();

      // The error frame carries the failure and marks the continuation.
      const frame = seen.find(
        (m) => isUseChatResponseMessage(m) && m.error === true
      );
      expect(frame).toMatchObject({
        body: "The model is unavailable",
        continuation: true
      });
      // Observers see it, as they see a failed request or a stream error.
      expect(observed).toContain("message:error");
      ws.close(1000);
    } finally {
      unsubscribe();
    }
  });

  it("onChatResponse for a failed continuation can start a turn, and is not entered again while it runs", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    await agent.persistMessages([user1, toolReply("assistant-1", "call-1")]);
    await agent.setTestBody({ failContinuations: true });
    await agent.setFallbackOnFailedContinuationForTest(true);

    // The continuation fails before it streams. The app's hook answers with
    // a turn of its own.
    send(ws, toolResult("call-1"));
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 2
    );
    await delay(300);
    await agent.waitForIdleForTest();

    const report = await agent.responseHookReportForTest();
    // The fallback turn's own result is delivered after the hook that
    // started it returned, not inside it.
    expect(report.statuses).toEqual(["continuation:error", "turn:completed"]);
    expect(report.reentrant).toBe(0);
    ws.close(1000);
  });

  it("continuations that keep failing stop once every result had its attempt", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);
    const reply: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-testTool",
          toolCallId: "call-1",
          state: "input-available",
          input: {}
        },
        {
          type: "tool-otherTool",
          toolCallId: "call-2",
          state: "approval-responded",
          input: {},
          approval: { id: "approval-2", approved: true }
        }
      ] as ChatMessage["parts"]
    };
    await agent.persistMessages([user1, reply]);
    await agent.setTestBody({ delayMs: 300, failContinuations: true });

    // The second result lands while the first one's continuation waits on
    // the model. Both continuations fail.
    send(ws, toolResult("call-1"));
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 1
    );
    send(ws, toolResult("call-2"));
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 2
    );
    await delay(500);
    await agent.waitForIdleForTest();

    // A resent result changes nothing, so it starts nothing.
    send(ws, toolResult("call-2"));
    await delay(300);
    await agent.waitForIdleForTest();

    expect(await agent.getChatMessageCallCountForTest()).toBe(2);
    const errorFrames = seen.filter(
      (m) => isUseChatResponseMessage(m) && m.error === true && m.done === true
    );
    expect(errorFrames).toHaveLength(2);
    expect(await agent.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false
    });
    ws.close(1000);
  });

  it("a result for a call the reply already answered past does not continue it", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);
    // The reply called a client tool and then went on to its answer in a
    // later step. Continuing it would send a transcript that ends in
    // assistant text.
    const reply: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-testTool",
          toolCallId: "call-1",
          state: "input-available",
          input: {}
        },
        { type: "step-start" },
        { type: "text", text: "Here is the answer." }
      ] as ChatMessage["parts"]
    };
    await agent.persistMessages([user1, reply]);

    send(ws, toolResult("call-1"));
    await waitUntil(() =>
      seen.some((m) => m.type === MessageType.CF_AGENT_STREAM_RESUME_NONE)
    );
    await agent.waitForIdleForTest();

    expect(await agent.getChatMessageCallCountForTest()).toBe(0);
    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored[1].parts[1]).toMatchObject({ state: "output-available" });
    expect(stored[1].parts).toHaveLength(4);
    ws.close(1000);
  });

  it("a reply with the tool call and the answer in one step continues for a result answered while it streamed", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);

    // The stream writes no `start-step` between the call and its text, and
    // finishes on `stop`. The request built from that reply ends in the
    // tool result, not in assistant text, so the continuation is owed.
    sendChatRequest(ws, "req-1", [user1], {
      answerInSameStepAsToolCall: true
    });
    await waitUntil(() =>
      responses(seen, "req-1").some((m) => m.body.includes("call_same_step"))
    );
    send(ws, {
      type: MessageType.CF_AGENT_TOOL_RESULT,
      toolCallId: "call_same_step",
      toolName: "fastClientTool",
      output: { ok: true },
      autoContinue: true
    });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.done));

    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 2
    );
    await delay(300);
    await agent.waitForIdleForTest();
    expect(await agent.getChatMessageCallCountForTest()).toBe(2);
    ws.close(1000);
  });

  it("a result answered while a continuation streamed still continues after that stream errors", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);
    const reply: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-testTool",
          toolCallId: "call-1",
          state: "input-available",
          input: {}
        },
        {
          type: "tool-otherTool",
          toolCallId: "call-2",
          state: "approval-responded",
          input: {},
          approval: { id: "approval-2", approved: true }
        }
      ] as ChatMessage["parts"]
    };
    await agent.persistMessages([user1, reply]);
    await agent.setTestBody({
      continuationStreamError: "The provider failed",
      continuationStreamErrorDelayMs: 300
    });
    const continuationFrames = () =>
      seen.filter(
        (m) => isUseChatResponseMessage(m) && m.continuation === true
      );

    // The first result's continuation starts to stream. A second result
    // lands while it does, and then the stream errors.
    send(ws, toolResult("call-1"));
    await waitUntil(() => continuationFrames().length > 0);
    send(ws, toolResult("call-2"));

    // No model call has read the second result, so it still gets its
    // continuation, as it does after a continuation that failed before it
    // streamed. Each errored stream ends in one error frame.
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 2
    );
    await delay(900);
    await agent.waitForIdleForTest();
    expect(await agent.getChatMessageCallCountForTest()).toBe(2);
    expect(
      seen.filter((m) => isUseChatResponseMessage(m) && m.error === true)
    ).toHaveLength(2);
    expect(await agent.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false
    });
    ws.close(1000);
  });

  it("reports a continuation it drops, with the reason", async () => {
    const room = crypto.randomUUID();
    const dropped: string[] = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:continuation:dropped" && event.name === room) {
        dropped.push(event.payload.reason);
      }
    });
    try {
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      const seen = record(ws);
      const agent = await getAgentByName(env.TestChatAgent, room);
      const answered: ChatMessage = {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-testTool",
            toolCallId: "call-1",
            state: "input-available",
            input: {}
          },
          { type: "step-start" },
          { type: "text", text: "Here is the answer." }
        ] as ChatMessage["parts"]
      };
      await agent.persistMessages([user1, answered]);

      send(ws, toolResult("call-1"));
      await waitUntil(() =>
        seen.some((m) => m.type === MessageType.CF_AGENT_STREAM_RESUME_NONE)
      );
      await agent.waitForIdleForTest();

      expect(dropped).toEqual(["answered"]);
      expect(await agent.getChatMessageCallCountForTest()).toBe(0);
      ws.close(1000);
    } finally {
      unsubscribe();
    }
  });

  it("a stopped reply does not continue for a tool result answered while it streamed", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);

    // The reply streams a client tool call and keeps streaming.
    sendChatRequest(ws, "req-1", [user1], {
      consumeClientToolResultWithinStream: true
    });
    await waitUntil(() =>
      responses(seen, "req-1").some((m) =>
        m.body.includes("call_consumed_within_stream")
      )
    );
    // The tab answers the call while the reply streams, then the user stops
    // the reply.
    send(ws, {
      type: MessageType.CF_AGENT_TOOL_RESULT,
      toolCallId: "call_consumed_within_stream",
      toolName: "fastClientTool",
      output: { ok: true },
      autoContinue: true
    });
    send(ws, { type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL, id: "req-1" });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.done));
    await delay(300);
    await agent.waitForIdleForTest();

    // Stop means stop: the model is not called again.
    expect(await agent.getChatMessageCallCountForTest()).toBe(1);
    expect(await agent.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false
    });
    // The answer is kept for the next turn.
    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    const call = stored
      .flatMap((m) => m.parts)
      .find(
        (part) =>
          "toolCallId" in part &&
          part.toolCallId === "call_consumed_within_stream"
      );
    expect(call).toMatchObject({ state: "output-available" });
    ws.close(1000);
  });

  it("stopping every request also drops the continuation of a result answered while the reply streamed", async () => {
    const room = crypto.randomUUID();
    const dropped: string[] = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:continuation:dropped" && event.name === room) {
        dropped.push(event.payload.reason);
      }
    });
    try {
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      const seen = record(ws);
      const agent = await getAgentByName(env.TestChatAgent, room);

      sendChatRequest(ws, "req-1", [user1], {
        consumeClientToolResultWithinStream: true
      });
      await waitUntil(() =>
        responses(seen, "req-1").some((m) =>
          m.body.includes("call_consumed_within_stream")
        )
      );
      send(ws, {
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_consumed_within_stream",
        toolName: "fastClientTool",
        output: { ok: true },
        autoContinue: true
      });
      await waitUntil(
        async () => (await agent.pendingContinuationRequestIdForTest()) !== null
      );
      // The app stops everything, not through the WebSocket cancel.
      await agent.abortAllRequestsForTest();
      await waitUntil(() => responses(seen, "req-1").some((m) => m.done));
      await delay(300);
      await agent.waitForIdleForTest();

      expect(await agent.getChatMessageCallCountForTest()).toBe(1);
      expect(dropped).toEqual(["stopped"]);
      ws.close(1000);
    } finally {
      unsubscribe();
    }
  });

  it("a stopped continuation does not run the result that arrived while it ran", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    const reply: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-testTool",
          toolCallId: "call-1",
          state: "input-available",
          input: {}
        },
        {
          type: "tool-otherTool",
          toolCallId: "call-2",
          state: "approval-responded",
          input: {},
          approval: { id: "approval-2", approved: true }
        }
      ] as ChatMessage["parts"]
    };
    await agent.persistMessages([user1, reply]);
    await agent.setTestBody({ delayMs: 400 });

    // The first result's continuation waits on the model. A second result
    // lands meanwhile, and then the user stops the continuation.
    send(ws, toolResult("call-1"));
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 1
    );
    const continuationId = await agent.pendingContinuationRequestIdForTest();
    expect(continuationId).not.toBeNull();
    send(ws, toolResult("call-2"));
    await waitUntil(
      async () =>
        (await agent.getContinuationStateForTest()).hasDeferred === true
    );
    send(ws, {
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      id: continuationId
    });
    await delay(900);
    await agent.waitForIdleForTest();

    // Stop means stop: the second result does not start the model again.
    expect(await agent.getChatMessageCallCountForTest()).toBe(1);
    expect(await agent.getContinuationStateForTest()).toMatchObject({
      hasPending: false,
      hasDeferred: false
    });
    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored[1].parts[1]).toMatchObject({ state: "output-available" });
    ws.close(1000);
  });

  it("a result that arrives after a continuation was stopped still continues", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    const reply: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-testTool",
          toolCallId: "call-1",
          state: "input-available",
          input: {}
        },
        {
          type: "tool-otherTool",
          toolCallId: "call-2",
          state: "approval-responded",
          input: {},
          approval: { id: "approval-2", approved: true }
        }
      ] as ChatMessage["parts"]
    };
    await agent.persistMessages([user1, reply]);
    await agent.setTestBody({ delayMs: 400 });

    // The first result's continuation waits on the model, and the user
    // stops it. The stopped turn is still winding down when a second
    // result arrives: that is a new action.
    send(ws, toolResult("call-1"));
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 1
    );
    const continuationId = await agent.pendingContinuationRequestIdForTest();
    send(ws, {
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      id: continuationId
    });
    await delay(50);
    send(ws, toolResult("call-2"));

    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 2
    );
    await delay(600);
    await agent.waitForIdleForTest();
    expect(await agent.getChatMessageCallCountForTest()).toBe(2);
    ws.close(1000);
  });

  it("a skipped regenerate leaves the stored tools and body alone", async () => {
    const room = crypto.randomUUID();
    const { ws: tabA } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const { ws: tabB } = await connectChatWS(
      `/agents/slow-stream-agent/${room}`
    );
    const seen = record(tabA);
    const seenB = record(tabB);
    const agent = await getAgentByName(env.SlowStreamAgent, room);

    // Tab A's reply streams; tab B regenerates it, so B waits in the queue.
    sendChatRequest(tabA, "req-1", [user1], {
      format: "plaintext",
      chunkCount: 10,
      chunkDelayMs: 30,
      owner: "tab-a"
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
          owner: "tab-b"
        })
      }
    });
    await waitUntil(() =>
      seen
        .slice(beforeRegenerate)
        .some((m) => m.type === MessageType.CF_AGENT_CHAT_MESSAGES)
    );
    // A question is stored while the regenerate waits, so it is skipped.
    await agent.persistMessages([user1, user2]);
    await waitUntil(() => responses(seenB, "req-2").some((m) => m.done), 6000);
    await agent.waitForIdleForTest();

    expect(responses(seenB, "req-2").filter((m) => m.done)).toEqual([
      expect.objectContaining({ outcome: "skipped" })
    ]);
    // The regenerate never ran. Later turns still run with tab A's body.
    expect(await agent.getStoredBodyForTest()).toMatchObject({
      owner: "tab-a"
    });
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
    // The text tells the model the truth: the client's tool may have run.
    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored[1].parts[0]).toMatchObject({
      toolCallId: "call-1",
      state: "output-error",
      errorText:
        "The conversation moved on before this tool call was answered. The tool may still have run."
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

  it("reports the calls a turn settles on the transcript channel", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);
    await agent.persistMessages([user1, toolReply("assistant-1", "call-1")]);

    const repaired: Array<string[] | undefined> = [];
    const unsubscribe = subscribe("transcript", (event) => {
      if (event.type === "chat:transcript:repaired" && event.name === room) {
        repaired.push(event.payload.toolCallIds);
      }
    });
    try {
      sendChatRequest(ws, "req-2", [
        user1,
        toolReply("assistant-1", "call-1"),
        user2
      ]);
      await waitUntil(() => responses(seen, "req-2").some((m) => m.done));
      await agent.waitForIdleForTest();
    } finally {
      unsubscribe();
    }

    expect(repaired).toEqual([["call-1"]]);
    ws.close(1000);
  });

  it("a tool result that lists no client tools continues with the stored ones", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    const clientTools = [{ name: "testTool", description: "A client tool" }];
    await agent.setClientToolsForTest(clientTools);
    await agent.persistMessages([user1, toolReply("assistant-1", "call-1")]);

    // The answering tab lists no tools of its own. The continuation still
    // belongs to the turn whose request stored the tools.
    send(ws, { ...toolResult("call-1"), clientTools: [] });
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 1
    );
    await agent.waitForIdleForTest();

    expect(await agent.getCapturedClientTools()).toEqual(clientTools);
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
      state: "output-error",
      errorText:
        "The conversation moved on before this tool call was approved or denied. It did not run."
    });
    ws.close(1000);
  });

  it("a duplicate tool result from another tab leaves the stored tools", async () => {
    const room = crypto.randomUUID();
    const { ws: tabA } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: tabB } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    const toolsOfA = [{ name: "testTool", description: "Tab A's tool" }];
    const toolsOfB = [{ name: "otherTool", description: "Tab B's tool" }];
    await agent.setClientToolsForTest(toolsOfA);
    await agent.persistMessages([user1, toolReply("assistant-1", "call-1")]);

    // Tab A's result settles the call and lists its tools.
    send(tabA, { ...toolResult("call-1"), clientTools: toolsOfA });
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 1
    );
    await agent.waitForIdleForTest();

    // Tab B answers the same call late, listing other tools. Its result
    // settles nothing, so it must not change which tools the chat offers
    // the model, or which calls a client owns.
    send(tabB, { ...toolResult("call-1"), clientTools: toolsOfB });
    await delay(300);
    await agent.waitForIdleForTest();

    expect(await agent.getStoredClientToolsForTest()).toEqual(toolsOfA);
    expect(await agent.getChatMessageCallCountForTest()).toBe(1);
    tabA.close(1000);
    tabB.close(1000);
  });

  it("a tool result that settles its call replaces the stored tools for its continuation", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const agent = await getAgentByName(env.TestChatAgent, room);
    const newer = [{ name: "otherTool", description: "A newer schema" }];
    await agent.setClientToolsForTest([
      { name: "testTool", description: "A client tool" }
    ]);
    await agent.persistMessages([user1, toolReply("assistant-1", "call-1")]);

    send(ws, { ...toolResult("call-1"), clientTools: newer });
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 1
    );
    await agent.waitForIdleForTest();

    expect(await agent.getStoredClientToolsForTest()).toEqual(newer);
    expect(await agent.getCapturedClientTools()).toEqual(newer);
    ws.close(1000);
  });

  it("a reply that ends in reasoning is never sent to the model that way", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);
    // An earlier reply was cut off right after the model's reasoning, and an
    // older version stored it as it was. Anthropic rejects every later
    // request that holds it: "The final block in an assistant message
    // cannot be thinking".
    const cutOff: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "Looking into it." },
        { type: "step-start" },
        {
          type: "reasoning",
          text: "Let me think",
          state: "done",
          providerMetadata: { anthropic: { signature: "sig" } }
        }
      ] as ChatMessage["parts"]
    };
    await agent.persistMessages([user1, cutOff]);

    const repaired: Array<number | undefined> = [];
    const unsubscribe = subscribe("transcript", (event) => {
      if (event.type === "chat:transcript:repaired" && event.name === room) {
        repaired.push(event.payload.removedReasoningParts);
      }
    });
    try {
      sendChatRequest(ws, "req-2", [user1, cutOff, user2]);
      await waitUntil(() => responses(seen, "req-2").some((m) => m.done));
      await agent.waitForIdleForTest();
    } finally {
      unsubscribe();
    }

    expect(await agent.getChatMessageCallCountForTest()).toBe(1);
    expect(await agent.getEndsInReasoningAtModelCallForTest()).toEqual([]);
    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored[1].parts.map((part) => part.type)).toEqual([
      "step-start",
      "text"
    ]);
    expect(repaired).toEqual([1]);
    ws.close(1000);
  });

  it("a new question removes an earlier reply that held only reasoning, in every tab", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: otherTab } = await connectChatWS(
      `/agents/test-chat-agent/${room}`
    );
    const seen = record(ws);
    const seenByOtherTab = record(otherTab);
    const agent = await getAgentByName(env.TestChatAgent, room);
    // A reply that finished as reasoning alone: the model ran out of output
    // tokens while it was thinking. Without its reasoning it holds nothing,
    // and every Anthropic model rejects a request that carries it.
    const cutOff: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "Let me think", state: "done" }
      ] as ChatMessage["parts"]
    };
    await agent.persistMessages([user1, cutOff]);

    const removedMessages: unknown[] = [];
    const unsubscribe = subscribe("transcript", (event) => {
      if (event.type === "chat:transcript:repaired" && event.name === room) {
        removedMessages.push(...(event.payload.removedMessages ?? []));
      }
    });
    try {
      sendChatRequest(ws, "req-2", [user1, cutOff, user2]);
      await waitUntil(() => responses(seen, "req-2").some((m) => m.done));
      await agent.waitForIdleForTest();
    } finally {
      unsubscribe();
    }

    // The event carries the reply as it was stored, so an app can keep it.
    expect(removedMessages).toEqual([cutOff]);

    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored.map((message) => message.id)).not.toContain("assistant-1");
    expect(stored.slice(0, 2).map((message) => message.id)).toEqual([
      "user-1",
      "user-2"
    ]);
    // The other tab is told with the whole list, so it drops the reply.
    const lists = seenByOtherTab.filter(
      (
        m
      ): m is Extract<
        OutgoingMessage,
        { type: MessageType.CF_AGENT_CHAT_MESSAGES }
      > => m.type === MessageType.CF_AGENT_CHAT_MESSAGES
    );
    expect(
      lists.some(
        (m) =>
          m.messages.some((message) => message.id === "user-2") &&
          !m.messages.some((message) => message.id === "assistant-1")
      )
    ).toBe(true);
    expect(await agent.getEndsInReasoningAtModelCallForTest()).toEqual([]);
    ws.close(1000);
    otherTab.close(1000);
  });

  it("a tab is sent the text-start of a continuation that follows a cut-off text part", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    // The tab that sends the result is offered the stream to resume. Another
    // tab gets its chunks as they are broadcast.
    const { ws: otherTab } = await connectChatWS(
      `/agents/test-chat-agent/${room}`
    );
    const seen = record(otherTab);
    const agent = await getAgentByName(env.TestChatAgent, room);
    // The reply was cut off in its text, after a client tool call.
    const cutOff: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-testTool",
          toolCallId: "call-1",
          state: "input-available",
          input: {}
        },
        { type: "text", text: "Partial ", state: "streaming" }
      ] as ChatMessage["parts"]
    };
    await agent.persistMessages([user1, cutOff]);

    send(ws, toolResult("call-1"));
    await waitUntil(
      async () => (await agent.getChatMessageCallCountForTest()) === 1
    );
    await agent.waitForIdleForTest();

    // The continuation's text is a part of its own, so the tab is told when
    // it starts. It used to get deltas for the old part and no start.
    const chunks = seen
      .filter(isUseChatResponseMessage)
      .map((m) => m.body)
      .filter((body) => body.length > 0);
    expect(chunks.some((body) => body.includes('"text-start"'))).toBe(true);
    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    const texts = stored[1].parts.filter((part) => part.type === "text");
    expect(texts[0]).toMatchObject({ text: "Partial ", state: "done" });
    expect(texts.length).toBe(2);
    ws.close(1000);
    otherTab.close(1000);
  });

  it("a reply stopped in its reasoning is stored nowhere, and every tab is told after the terminal frame", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: otherTab } = await connectChatWS(
      `/agents/test-chat-agent/${room}`
    );
    const seen = record(ws);
    const seenByOtherTab = record(otherTab);
    const agent = await getAgentByName(env.TestChatAgent, room);

    sendChatRequest(ws, "req-1", [user1], {
      reasoningThenHang: true,
      hangIn: "reasoning"
    });
    await waitUntil(() =>
      responses(seenByOtherTab, "req-1").some((m) =>
        m.body.includes("reasoning-end")
      )
    );
    send(ws, { type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL, id: "req-1" });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.done));
    await agent.waitForIdleForTest();

    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored.map((message) => message.id)).toEqual(["user-1"]);
    // Both tabs drew the reasoning. A message list after the terminal frame
    // drops it: one before it is merged with the stream a tab still reads.
    for (const frames of [seen, seenByOtherTab]) {
      const done = frames.findIndex(
        (m) => isUseChatResponseMessage(m) && m.id === "req-1" && m.done
      );
      expect(done).toBeGreaterThanOrEqual(0);
      const after = frames
        .slice(done + 1)
        .filter(
          (
            m
          ): m is Extract<
            OutgoingMessage,
            { type: MessageType.CF_AGENT_CHAT_MESSAGES }
          > => m.type === MessageType.CF_AGENT_CHAT_MESSAGES
        );
      expect(after.length).toBeGreaterThan(0);
      expect(after.at(-1)?.messages.map((message) => message.role)).toEqual([
        "user"
      ]);
    }
    ws.close(1000);
    otherTab.close(1000);
  });

  it("a reply stopped in the middle of its text is stored with that text part closed", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);

    sendChatRequest(ws, "req-1", [user1], {
      reasoningThenHang: true,
      hangIn: "text"
    });
    await waitUntil(() =>
      responses(seen, "req-1").some((m) => m.body.includes("Partial answer"))
    );
    send(ws, { type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL, id: "req-1" });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.done));
    await agent.waitForIdleForTest();

    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    // Nothing will write into the part again, so it is not left `streaming`.
    expect(stored.at(-1)?.parts.at(-1)).toEqual({
      type: "text",
      text: "Partial answer",
      state: "done"
    });
    ws.close(1000);
  });

  it("a reply stopped right after the model's reasoning is stored without it", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const seen = record(ws);
    const agent = await getAgentByName(env.TestChatAgent, room);

    sendChatRequest(ws, "req-1", [user1], { reasoningThenHang: true });
    await waitUntil(() =>
      responses(seen, "req-1").some((m) => m.body.includes("reasoning-end"))
    );
    send(ws, { type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL, id: "req-1" });
    await waitUntil(() => responses(seen, "req-1").some((m) => m.done));
    await agent.waitForIdleForTest();

    const stored = (await agent.getPersistedMessages()) as ChatMessage[];
    expect(stored.at(-1)?.role).toBe("assistant");
    expect(stored.at(-1)?.parts.some((part) => part.type === "reasoning")).toBe(
      false
    );
    expect(stored.at(-1)?.parts.at(-1)).toMatchObject({
      type: "text",
      text: "Partial answer"
    });
    ws.close(1000);
  });
});
