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
});
