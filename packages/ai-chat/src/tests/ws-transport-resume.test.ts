import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UIMessage as ChatMessage, UIMessageChunk } from "ai";
import { WebSocketChatTransport } from "../ws-chat-transport";
import { MessageType } from "../types";

/**
 * Minimal mock of the AgentConnection interface.
 * Supports both addEventListener listeners AND direct handleStreamResuming calls.
 */
function createMockAgent() {
  const sent: string[] = [];
  const target = new EventTarget();

  return {
    sent,
    target,
    send(data: string) {
      sent.push(data);
    },
    addEventListener(
      type: string,
      listener: (event: MessageEvent) => void,
      options?: { signal?: AbortSignal }
    ) {
      target.addEventListener(type, listener as EventListener, options);
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      target.removeEventListener(type, listener as EventListener);
    },
    /** Simulate a message arriving from the server */
    dispatch(data: Record<string, unknown>) {
      target.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(data) })
      );
    }
  };
}

describe("WebSocketChatTransport reconnectToStream + handleStreamResuming", () => {
  let agent: ReturnType<typeof createMockAgent>;
  let activeRequestIds: Set<string>;
  let transport: WebSocketChatTransport<ChatMessage>;

  beforeEach(() => {
    agent = createMockAgent();
    activeRequestIds = new Set();
    transport = new WebSocketChatTransport<ChatMessage>({
      agent,
      activeRequestIds
    });
  });

  // ── handleStreamResuming basics ──────────────────────────────────────

  it("handleStreamResuming returns false when no reconnectToStream is pending", () => {
    expect(transport.handleStreamResuming({ id: "req-1" })).toBe(false);
  });

  // ── reconnectToStream sends RESUME_REQUEST ───────────────────────────

  it("sends CF_AGENT_STREAM_RESUME_REQUEST immediately", async () => {
    // Start reconnectToStream (don't await — it's waiting for handleStreamResuming)
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    // Verify the request was sent
    expect(agent.sent).toHaveLength(1);
    const msg = JSON.parse(agent.sent[0]);
    expect(msg.type).toBe(MessageType.CF_AGENT_STREAM_RESUME_REQUEST);

    // Resolve by calling handleStreamResuming
    transport.handleStreamResuming({ id: "req-1" });

    const result = await promise;
    expect(result).toBeInstanceOf(ReadableStream);
  });

  // ── handleStreamResuming resolves reconnectToStream ──────────────────

  it("resolves with ReadableStream when handleStreamResuming is called", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    // Simulate onAgentMessage calling handleStreamResuming
    const handled = transport.handleStreamResuming({ id: "req-abc" });
    expect(handled).toBe(true);

    const stream = await promise;
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it("sends ACK when handleStreamResuming is called", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    transport.handleStreamResuming({ id: "req-42" });
    await promise;

    // First message is RESUME_REQUEST, second is ACK
    expect(agent.sent).toHaveLength(2);
    const ack = JSON.parse(agent.sent[1]);
    expect(ack.type).toBe(MessageType.CF_AGENT_STREAM_RESUME_ACK);
    expect(ack.id).toBe("req-42");
  });

  it("adds requestId to activeRequestIds when handleStreamResuming is called", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    transport.handleStreamResuming({ id: "req-tracked" });
    await promise;

    expect(activeRequestIds.has("req-tracked")).toBe(true);
  });

  // ── Timeout behavior ─────────────────────────────────────────────────

  it("resolves null after timeout when no handleStreamResuming is called", async () => {
    vi.useFakeTimers();
    try {
      const promise = transport.reconnectToStream({ chatId: "chat-1" });

      // Advance past the 5s timeout
      vi.advanceTimersByTime(5001);

      const result = await promise;
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears _resumeResolver after timeout so handleStreamResuming returns false", async () => {
    vi.useFakeTimers();
    try {
      const promise = transport.reconnectToStream({ chatId: "chat-1" });
      vi.advanceTimersByTime(5001);
      await promise;

      // After timeout, resolver is cleared
      expect(transport.handleStreamResuming({ id: "late" })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Idempotency / double-call safety ─────────────────────────────────

  it("only the latest reconnectToStream's resolver is active (React strict mode)", async () => {
    vi.useFakeTimers();
    try {
      // Simulate React strict mode: effect runs twice
      const promise1 = transport.reconnectToStream({ chatId: "chat-1" });
      const promise2 = transport.reconnectToStream({ chatId: "chat-1" });

      // handleStreamResuming only triggers the LATEST resolver
      const handled = transport.handleStreamResuming({ id: "req-sm" });
      expect(handled).toBe(true);

      // Second call resolves with a stream
      const stream2 = await promise2;
      expect(stream2).toBeInstanceOf(ReadableStream);

      // First call's resolver was overwritten — it times out
      vi.advanceTimersByTime(5001);
      const stream1 = await promise1;
      expect(stream1).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("handleStreamResuming returns false after resolver is consumed", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    // First call succeeds
    expect(transport.handleStreamResuming({ id: "req-1" })).toBe(true);
    await promise;

    // Second call — resolver was cleared
    expect(transport.handleStreamResuming({ id: "req-2" })).toBe(false);
  });

  // ── Chunk reception via _createResumeStream ──────────────────────────

  it("returns a stream that receives chunks via addEventListener", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    transport.handleStreamResuming({ id: "req-chunks" });
    const stream = await promise;
    expect(stream).toBeInstanceOf(ReadableStream);

    const reader = stream!.getReader();

    // Simulate chunk arriving over WebSocket
    agent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-chunks",
      body: '{"type":"text-start","id":"t1"}',
      done: false,
      replay: true
    });

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect((value as UIMessageChunk).type).toBe("text-start");
  });

  it("stream closes when done:true chunk arrives", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    transport.handleStreamResuming({ id: "req-done" });
    const stream = await promise;
    const reader = stream!.getReader();

    // Send a chunk then done
    agent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-done",
      body: '{"type":"text-start","id":"t1"}',
      done: false
    });
    agent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-done",
      body: '{"type":"text-delta","id":"t1","delta":"Hello"}',
      done: false
    });
    agent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-done",
      body: "",
      done: true
    });

    const chunks: UIMessageChunk[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe("text-start");
    expect(chunks[1].type).toBe("text-delta");
  });

  it("removes requestId from activeRequestIds when stream completes", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    transport.handleStreamResuming({ id: "req-cleanup" });
    const stream = await promise;
    const reader = stream!.getReader();

    expect(activeRequestIds.has("req-cleanup")).toBe(true);

    // Complete the stream
    agent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-cleanup",
      body: "",
      done: true
    });

    await reader.read(); // { done: true }

    expect(activeRequestIds.has("req-cleanup")).toBe(false);
  });

  it("stream ignores chunks for different request IDs", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    transport.handleStreamResuming({ id: "req-A" });
    const stream = await promise;
    const reader = stream!.getReader();

    // This chunk is for a different request — should be ignored
    agent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-B",
      body: '{"type":"text-start","id":"t1"}',
      done: false
    });

    // This chunk is for our request — should be received
    agent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-A",
      body: '{"type":"text-delta","id":"t1","delta":"correct"}',
      done: false
    });

    const { value } = await reader.read();
    expect((value as { type: string; delta?: string }).delta).toBe("correct");
  });

  // ── Error handling ───────────────────────────────────────────────────

  it("stream errors when error chunk arrives", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    transport.handleStreamResuming({ id: "req-err" });
    const stream = await promise;
    const reader = stream!.getReader();

    agent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-err",
      body: "Something went wrong",
      error: true
    });

    await expect(reader.read()).rejects.toThrow("Something went wrong");
  });

  it("stream errors with fallback message when error body is empty", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    transport.handleStreamResuming({ id: "req-err2" });
    const stream = await promise;
    const reader = stream!.getReader();

    agent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-err2",
      body: "",
      error: true
    });

    await expect(reader.read()).rejects.toThrow("Stream error");
  });

  // ── send() failure tolerance ─────────────────────────────────────────

  it("reconnectToStream does not throw when send() throws", async () => {
    const failAgent = createMockAgent();
    failAgent.send = () => {
      throw new Error("WebSocket closed");
    };
    const failTransport = new WebSocketChatTransport<ChatMessage>({
      agent: failAgent
    });

    vi.useFakeTimers();
    try {
      const promise = failTransport.reconnectToStream({ chatId: "chat-1" });

      // Should not throw — the try/catch handles it
      vi.advanceTimersByTime(5001);
      const result = await promise;
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── No activeRequestIds (optional) ───────────────────────────────────

  // ── Double STREAM_RESUMING (server sends from onConnect + RESUME_REQUEST) ──

  it("activeRequestIds contains the ID after handleStreamResuming so caller can dedupe", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    // First STREAM_RESUMING — transport handles it
    expect(transport.handleStreamResuming({ id: "req-dup" })).toBe(true);
    await promise;

    // requestId is now in activeRequestIds
    expect(activeRequestIds.has("req-dup")).toBe(true);

    // Second STREAM_RESUMING with same ID — transport returns false
    // (resolver consumed), but the caller can check activeRequestIds
    // to skip the fallback and avoid a duplicate ACK.
    expect(transport.handleStreamResuming({ id: "req-dup" })).toBe(false);
    expect(activeRequestIds.has("req-dup")).toBe(true);
  });

  it("works without activeRequestIds", async () => {
    const noIdsTransport = new WebSocketChatTransport<ChatMessage>({
      agent
    });

    const promise = noIdsTransport.reconnectToStream({ chatId: "chat-1" });
    const handled = noIdsTransport.handleStreamResuming({ id: "req-noids" });
    expect(handled).toBe(true);

    const stream = await promise;
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  // ── Singleton transport: agent update survives resolver ───────────

  it("agent property can be updated after construction", () => {
    const newAgent = createMockAgent();
    transport.agent = newAgent;
    expect(transport.agent).toBe(newAgent);
  });

  it("resolver survives agent swap — handleStreamResuming works on same transport", async () => {
    // Start reconnectToStream on the original agent
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    // Simulate _pk change: swap agent to a new socket
    const newAgent = createMockAgent();
    transport.agent = newAgent;

    // handleStreamResuming still finds the resolver (same transport instance)
    const handled = transport.handleStreamResuming({ id: "req-swap" });
    expect(handled).toBe(true);

    const stream = await promise;
    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it("ACK is sent via the NEW agent after agent swap", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    // Swap to new agent before resolving
    const newAgent = createMockAgent();
    transport.agent = newAgent;

    transport.handleStreamResuming({ id: "req-ack-swap" });
    await promise;

    // ACK should go to the NEW agent, not the old one
    expect(newAgent.sent).toHaveLength(1);
    const ack = JSON.parse(newAgent.sent[0]);
    expect(ack.type).toBe(MessageType.CF_AGENT_STREAM_RESUME_ACK);
    expect(ack.id).toBe("req-ack-swap");

    // Old agent only received RESUME_REQUEST (no ACK)
    expect(agent.sent).toHaveLength(1);
    const req = JSON.parse(agent.sent[0]);
    expect(req.type).toBe(MessageType.CF_AGENT_STREAM_RESUME_REQUEST);
  });

  it("resumed chunk listener attaches to the agent at resolve time", async () => {
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    // Swap to new agent before resolving
    const newAgent = createMockAgent();
    transport.agent = newAgent;

    transport.handleStreamResuming({ id: "req-listen" });
    const stream = await promise;
    const reader = stream!.getReader();

    // Dispatch chunk on the NEW agent — should be received
    newAgent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-listen",
      body: '{"type":"text-delta","id":"t1","delta":"from-new"}',
      done: false
    });

    const { value } = await reader.read();
    expect((value as { type: string; delta?: string }).delta).toBe("from-new");
  });

  it("full agent-swap scenario: reconnect on old socket, resume on new socket", async () => {
    // 1. Start reconnectToStream on old agent (socket may be closed)
    const promise = transport.reconnectToStream({ chatId: "chat-1" });

    // 2. _pk changes — swap to new agent
    const newAgent = createMockAgent();
    transport.agent = newAgent;

    // 3. Server sends STREAM_RESUMING on the new socket
    //    (onAgentMessage calls handleStreamResuming on the same transport)
    transport.handleStreamResuming({ id: "req-full" });
    const stream = await promise;

    // 4. ACK goes to new agent
    expect(newAgent.sent).toHaveLength(1);
    expect(JSON.parse(newAgent.sent[0]).type).toBe(
      MessageType.CF_AGENT_STREAM_RESUME_ACK
    );

    // 5. Chunks arrive on new agent's EventTarget
    const reader = stream!.getReader();
    newAgent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-full",
      body: '{"type":"text-start","id":"t1"}',
      done: false
    });
    newAgent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-full",
      body: '{"type":"text-delta","id":"t1","delta":"hello"}',
      done: false
    });
    newAgent.dispatch({
      type: "cf_agent_use_chat_response",
      id: "req-full",
      body: "",
      done: true
    });

    const chunks: UIMessageChunk[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe("text-start");
    expect(chunks[1].type).toBe("text-delta");

    // 6. Request ID cleaned up
    expect(activeRequestIds.has("req-full")).toBe(false);
  });
});
