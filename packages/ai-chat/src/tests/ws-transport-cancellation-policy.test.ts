import { describe, expect, it } from "vitest";
import type { UIMessage as ChatMessage, UIMessageChunk } from "ai";
import { MessageType } from "../types";
import { WebSocketChatTransport } from "../ws-chat-transport";

function createMockAgent() {
  const sent: string[] = [];
  const listeners: Array<(event: MessageEvent) => void> = [];

  return {
    sent,
    listeners,
    send(data: string) {
      sent.push(data);
    },
    addEventListener(
      _type: string,
      listener: (event: MessageEvent) => void,
      _options?: { signal?: AbortSignal }
    ) {
      listeners.push(listener);
    },
    removeEventListener(
      _type: string,
      _listener: (event: MessageEvent) => void
    ) {
      // no-op for tests
    }
  };
}

const userMessage: ChatMessage = {
  id: "msg1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
};

async function expectAbortError(
  stream: ReadableStream<UIMessageChunk>
): Promise<void> {
  const reader = stream.getReader();
  await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
}

describe("WebSocketChatTransport cancellation policy", () => {
  it("treats client abort as local-only by default", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport<ChatMessage>({
      agent,
      activeRequestIds
    });
    const abortController = new AbortController();

    const stream = await transport.sendMessages({
      chatId: "chat-1",
      messages: [userMessage],
      abortSignal: abortController.signal,
      trigger: "submit-message"
    });

    expect(activeRequestIds.size).toBe(1);
    abortController.abort();

    expect(agent.sent).toHaveLength(1);
    expect(JSON.parse(agent.sent[0])).toMatchObject({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST
    });
    expect(activeRequestIds.size).toBe(0);
    await expectAbortError(stream);
  });

  it("does not start a server turn when the client signal is already aborted", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport<ChatMessage>({
      agent,
      activeRequestIds
    });
    const abortController = new AbortController();
    abortController.abort();

    const stream = await transport.sendMessages({
      chatId: "chat-1",
      messages: [userMessage],
      abortSignal: abortController.signal,
      trigger: "submit-message"
    });

    expect(agent.sent).toHaveLength(0);
    expect(activeRequestIds.size).toBe(0);
    await expectAbortError(stream);
    expect(transport.cancelActiveServerTurn()).toBe(false);
  });

  it("does not leak requestId when pre-aborted with cancelOnClientAbort enabled", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport<ChatMessage>({
      agent,
      activeRequestIds,
      cancelOnClientAbort: true
    });
    const abortController = new AbortController();
    abortController.abort();

    const stream = await transport.sendMessages({
      chatId: "chat-1",
      messages: [userMessage],
      abortSignal: abortController.signal,
      trigger: "submit-message"
    });

    expect(agent.sent).toHaveLength(0);
    expect(activeRequestIds.size).toBe(0);
    await expectAbortError(stream);
    expect(transport.cancelActiveServerTurn()).toBe(false);
  });

  it("treats stream.cancel() as local-only by default", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport<ChatMessage>({
      agent,
      activeRequestIds
    });

    const stream = await transport.sendMessages({
      chatId: "chat-1",
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });

    expect(activeRequestIds.size).toBe(1);
    await expect(stream.cancel()).resolves.toBeUndefined();

    expect(agent.sent).toHaveLength(1);
    expect(JSON.parse(agent.sent[0])).toMatchObject({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST
    });
    expect(activeRequestIds.size).toBe(0);
  });

  it("allows explicit server turn cancellation when client abort is local-only", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport<ChatMessage>({
      agent,
      activeRequestIds
    });

    const stream = await transport.sendMessages({
      chatId: "chat-1",
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });

    const [requestId] = activeRequestIds;
    expect(transport.cancelActiveServerTurn()).toBe(true);

    expect(agent.sent).toHaveLength(2);
    expect(JSON.parse(agent.sent[1])).toEqual({
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      id: requestId
    });
    expect(activeRequestIds.has(requestId)).toBe(true);
    await expectAbortError(stream);
  });

  it("allows explicit server turn cancellation after local-only client abort", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport<ChatMessage>({
      agent,
      activeRequestIds
    });
    const abortController = new AbortController();

    const stream = await transport.sendMessages({
      chatId: "chat-1",
      messages: [userMessage],
      abortSignal: abortController.signal,
      trigger: "submit-message"
    });

    const [requestId] = activeRequestIds;
    abortController.abort();
    await expectAbortError(stream);

    expect(agent.sent).toHaveLength(1);
    expect(transport.cancelActiveServerTurn()).toBe(true);
    expect(agent.sent).toHaveLength(2);
    expect(JSON.parse(agent.sent[1])).toEqual({
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      id: requestId
    });
  });

  it("allows explicit server turn cancellation for observed fallback streams", () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport<ChatMessage>({ agent });

    transport.observeServerTurn("observed-request");

    expect(transport.cancelActiveServerTurn()).toBe(true);
    expect(agent.sent).toHaveLength(1);
    expect(JSON.parse(agent.sent[0])).toEqual({
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      id: "observed-request"
    });
  });

  it("can opt in to server cancellation on client abort", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport<ChatMessage>({
      agent,
      activeRequestIds,
      cancelOnClientAbort: true
    });
    const abortController = new AbortController();

    const stream = await transport.sendMessages({
      chatId: "chat-1",
      messages: [userMessage],
      abortSignal: abortController.signal,
      trigger: "submit-message"
    });

    const [requestId] = activeRequestIds;
    abortController.abort();

    expect(agent.sent).toHaveLength(2);
    expect(JSON.parse(agent.sent[1])).toEqual({
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      id: requestId
    });
    expect(activeRequestIds.has(requestId)).toBe(true);
    await expectAbortError(stream);
  });

  it("can opt in to server cancellation on stream.cancel()", async () => {
    const agent = createMockAgent();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport<ChatMessage>({
      agent,
      activeRequestIds,
      cancelOnClientAbort: true
    });

    const stream = await transport.sendMessages({
      chatId: "chat-1",
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });

    const [requestId] = activeRequestIds;
    await expect(stream.cancel()).resolves.toBeUndefined();

    expect(agent.sent).toHaveLength(2);
    expect(JSON.parse(agent.sent[1])).toEqual({
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      id: requestId
    });
    expect(activeRequestIds.has(requestId)).toBe(true);
  });
});
