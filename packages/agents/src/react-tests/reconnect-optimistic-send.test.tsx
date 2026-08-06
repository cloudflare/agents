// Regression: the reconnect transcript replay must not drop a send buffered
// while the socket was down, but must still honor a rollback of a delivered
// send. Drives the real hook via a fake EventTarget agent whose send() returns
// false when buffered (like PartySocket) — that return, captured at the real
// send site in the transport, is what the fix reads to tell the two apart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render as _render, cleanup } from "vitest-browser-react";
import type { UIMessage } from "ai";
import type { useAgent } from "../react";
import { useAgentChat } from "../chat/react";
import type {
  PrepareSendMessagesRequestOptions,
  PrepareSendMessagesRequestResult
} from "../chat/react";

type PrepareSendMessagesRequest = (
  options: PrepareSendMessagesRequestOptions
) =>
  | Promise<PrepareSendMessagesRequestResult>
  | PrepareSendMessagesRequestResult;

// Async WebSocket-driven updates legitimately land outside act() here; disable
// the act environment after mount (mirrors the other react-tests in this dir).
const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeAgent({ name, url }: { name: string; url: string }) {
  const target = new EventTarget();
  const sentMessages: string[] = [];
  const agent = {
    _pkurl: url,
    _pk: name,
    _url: null as string | null,
    readyState: SOCKET_OPEN,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    id: "fake-agent",
    name,
    removeEventListener: target.removeEventListener.bind(target),
    // Mirror PartySocket: `send()` returns false when the frame is buffered
    // (socket not OPEN) rather than sent immediately.
    send: (data: string) => {
      sentMessages.push(data);
      return agent.readyState === SOCKET_OPEN;
    },
    dispatchEvent: target.dispatchEvent.bind(target),
    path: [{ agent: "Chat", name }],
    getHttpUrl: () =>
      url.replace("ws://", "http://").replace("wss://", "https://")
  };
  target.addEventListener("open", () => {
    agent.readyState = SOCKET_OPEN;
  });
  target.addEventListener("close", () => {
    agent.readyState = SOCKET_CLOSED;
  });
  return {
    agent: agent as unknown as ReturnType<typeof useAgent>,
    target,
    sentMessages
  };
}

function dispatch(target: EventTarget, data: Record<string, unknown>) {
  target.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data) })
  );
}

function open(target: EventTarget) {
  target.dispatchEvent(new Event("open"));
}

function close(target: EventTarget) {
  target.dispatchEvent(new Event("close"));
}

const RESUME_NONE = "cf_agent_stream_resume_none";
const CHAT_MESSAGES = "cf_agent_chat_messages";

const EXISTING_USER = "Existing question";
const EXISTING_ASSISTANT = "Existing answer";
const IN_FLIGHT_USER = "In-flight question sent during reconnect";
const DELIVERED_USER = "Delivered message the server dropped";

function makeInitialMessages(): UIMessage[] {
  return [
    {
      id: "user-existing",
      role: "user",
      parts: [{ type: "text", text: EXISTING_USER }]
    },
    {
      id: "assistant-existing",
      role: "assistant",
      parts: [{ type: "text", text: EXISTING_ASSISTANT }]
    }
  ];
}

// Persisted transcript without the just-sent message — the shape Think's
// _buildIdleConnectMessages and AIChatAgent's _rollbackDroppedSubmit both emit.
function transcriptSnapshot(): Record<string, unknown> {
  return { type: CHAT_MESSAGES, messages: makeInitialMessages() };
}

type AgentChatResult = ReturnType<typeof useAgentChat>;

function requireChat(chat: AgentChatResult | null): AgentChatResult {
  if (!chat) throw new Error("Chat hook was not initialized");
  return chat;
}

function mountChat(
  agent: ReturnType<typeof useAgent>,
  prepareSendMessagesRequest?: PrepareSendMessagesRequest
) {
  let chatInstance: AgentChatResult | null = null;

  function TestComponent() {
    const chat = useAgentChat({
      agent,
      getInitialMessages: null,
      messages: makeInitialMessages(),
      prepareSendMessagesRequest
    });
    chatInstance = chat;
    return (
      <div data-testid="transcript">
        {chat.messages.map((message) => (
          <div key={message.id} data-testid={`role-${message.role}`}>
            {message.parts.map((part, index) =>
              part.type === "text" ? <span key={index}>{part.text}</span> : null
            )}
          </div>
        ))}
      </div>
    );
  }

  return { TestComponent, getChat: () => chatInstance };
}

describe("useAgentChat reconnect transcript replay vs optimistic send", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    cleanup();
  });

  it("preserves a buffered optimistic send when the reconnect snapshot omits it", async () => {
    const { agent, target } = createFakeAgent({
      name: "buffered-send",
      url: "ws://localhost:3000/agents/chat/buffered-send?_pk=abc"
    });
    const { TestComponent, getChat } = mountChat(agent);

    const { container } = await render(<TestComponent />);
    const transcript = () =>
      container.querySelector('[data-testid="transcript"]')?.textContent ?? "";

    await vi.waitFor(() => {
      expect(transcript()).toContain(EXISTING_USER);
      expect(transcript()).toContain(EXISTING_ASSISTANT);
    });

    // Settle the mount-time resume probe so status is "ready".
    dispatch(target, { type: RESUME_NONE, reason: "idle" });
    await sleep(10);

    // The socket drops (readyState -> CLOSED). The user sends anyway:
    // PartySocket would buffer the frame; the AI SDK renders it optimistically.
    close(target);
    void requireChat(getChat()).sendMessage({ text: IN_FLIGHT_USER });

    await vi.waitFor(() => {
      expect(transcript()).toContain(IN_FLIGHT_USER);
    });

    // Reconnect: the server replays its idle-connect transcript, which does NOT
    // yet include the buffered send.
    open(target);
    dispatch(target, transcriptSnapshot());
    await sleep(50);

    // The reconnect replay must not drop the in-flight optimistic send.
    expect(transcript()).toContain(IN_FLIGHT_USER);
    expect(transcript()).toContain(EXISTING_USER);
    expect(transcript()).toContain(EXISTING_ASSISTANT);
  });

  it("does NOT resurrect a delivered send the server rolls back (socket open)", async () => {
    const { agent, target } = createFakeAgent({
      name: "delivered-rollback",
      url: "ws://localhost:3000/agents/chat/delivered-rollback?_pk=abc"
    });
    const { TestComponent, getChat } = mountChat(agent);

    const { container } = await render(<TestComponent />);
    const transcript = () =>
      container.querySelector('[data-testid="transcript"]')?.textContent ?? "";

    await vi.waitFor(() => {
      expect(transcript()).toContain(EXISTING_USER);
      expect(transcript()).toContain(EXISTING_ASSISTANT);
    });

    dispatch(target, { type: RESUME_NONE, reason: "idle" });
    await sleep(10);

    // Socket stays OPEN, so the send is delivered to the server (not buffered).
    expect((agent as unknown as { readyState: number }).readyState).toBe(
      SOCKET_OPEN
    );
    void requireChat(getChat()).sendMessage({ text: DELIVERED_USER });

    await vi.waitFor(() => {
      expect(transcript()).toContain(DELIVERED_USER);
    });

    // The server rejects the overlapping submit and rolls it back by pushing a
    // transcript snapshot that omits it (messageConcurrency: "drop"). The
    // rollback must win — the delivered send is removed, not resurrected.
    dispatch(target, transcriptSnapshot());
    await sleep(50);

    expect(transcript()).not.toContain(DELIVERED_USER);
    expect(transcript()).toContain(EXISTING_USER);
    expect(transcript()).toContain(EXISTING_ASSISTANT);
  });

  // Socket OPEN when sendMessage() is called, but CLOSED by the time the
  // transport actually calls send() (it drops during async request prep). The
  // frame buffers, so the message must survive the reconnect replay — the case
  // a readyState-at-call-time check would miss.
  it("preserves a send that buffers because the socket drops during request prep", async () => {
    const { agent, target } = createFakeAgent({
      name: "close-during-prep",
      url: "ws://localhost:3000/agents/chat/close-during-prep?_pk=abc"
    });
    const { TestComponent, getChat } = mountChat(agent, async () => {
      // Runs mid-send, before the transport's send(): drop the socket.
      close(target);
      return {};
    });

    const { container } = await render(<TestComponent />);
    const transcript = () =>
      container.querySelector('[data-testid="transcript"]')?.textContent ?? "";

    await vi.waitFor(() => {
      expect(transcript()).toContain(EXISTING_USER);
      expect(transcript()).toContain(EXISTING_ASSISTANT);
    });

    dispatch(target, { type: RESUME_NONE, reason: "idle" });
    await sleep(10);

    // Socket is OPEN at call time; the prepare callback closes it before send().
    expect((agent as unknown as { readyState: number }).readyState).toBe(
      SOCKET_OPEN
    );
    void requireChat(getChat()).sendMessage({ text: IN_FLIGHT_USER });

    await vi.waitFor(() => {
      expect(transcript()).toContain(IN_FLIGHT_USER);
    });

    open(target);
    dispatch(target, transcriptSnapshot());
    await sleep(50);

    expect(transcript()).toContain(IN_FLIGHT_USER);
    expect(transcript()).toContain(EXISTING_USER);
    expect(transcript()).toContain(EXISTING_ASSISTANT);
  });

  // Socket CLOSED when sendMessage() is called, but reopened before the
  // transport's send() runs. The frame is delivered, so a server rollback must
  // win — the case a readyState-at-call-time check would wrongly preserve.
  it("does NOT preserve a send delivered after the socket reopens during request prep", async () => {
    const { agent, target } = createFakeAgent({
      name: "open-during-prep",
      url: "ws://localhost:3000/agents/chat/open-during-prep?_pk=abc"
    });
    const { TestComponent, getChat } = mountChat(agent, async () => {
      // Runs mid-send, before the transport's send(): the socket recovers.
      open(target);
      return {};
    });

    const { container } = await render(<TestComponent />);
    const transcript = () =>
      container.querySelector('[data-testid="transcript"]')?.textContent ?? "";

    await vi.waitFor(() => {
      expect(transcript()).toContain(EXISTING_USER);
      expect(transcript()).toContain(EXISTING_ASSISTANT);
    });

    dispatch(target, { type: RESUME_NONE, reason: "idle" });
    await sleep(10);

    // Socket is CLOSED at call time; the prepare callback reopens it before send().
    close(target);
    expect((agent as unknown as { readyState: number }).readyState).toBe(
      SOCKET_CLOSED
    );
    void requireChat(getChat()).sendMessage({ text: DELIVERED_USER });

    await vi.waitFor(() => {
      expect(transcript()).toContain(DELIVERED_USER);
    });

    // Delivered on the reopened socket, then rolled back by the server snapshot.
    dispatch(target, transcriptSnapshot());
    await sleep(50);

    expect(transcript()).not.toContain(DELIVERED_USER);
    expect(transcript()).toContain(EXISTING_USER);
    expect(transcript()).toContain(EXISTING_ASSISTANT);
  });
});
