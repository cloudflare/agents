import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { WebSocketChatTransport } from "../ws-chat-transport";
import { MessageType } from "../types";

/**
 * Minimal mock of the AgentConnection interface.
 * Captures sent messages for assertion.
 */
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

describe("WebSocketChatTransport trigger field", () => {
  it("includes trigger in the body payload for submit-message", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport<ChatMessage>({ agent });

    await transport.sendMessages({
      chatId: "chat-1",
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message"
    });

    expect(agent.sent.length).toBe(1);

    const outer = JSON.parse(agent.sent[0]);
    expect(outer.type).toBe(MessageType.CF_AGENT_USE_CHAT_REQUEST);

    const body = JSON.parse(outer.init.body);
    expect(body.trigger).toBe("submit-message");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].id).toBe("msg1");
  });

  it("includes trigger in the body payload for regenerate-message", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport<ChatMessage>({ agent });

    await transport.sendMessages({
      chatId: "chat-1",
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "regenerate-message"
    });

    expect(agent.sent.length).toBe(1);

    const outer = JSON.parse(agent.sent[0]);
    const body = JSON.parse(outer.init.body);
    expect(body.trigger).toBe("regenerate-message");
  });

  it("includes trigger alongside prepareBody extra fields", async () => {
    const agent = createMockAgent();
    const transport = new WebSocketChatTransport<ChatMessage>({
      agent,
      prepareBody: async ({ trigger }) => ({
        model: "gpt-4",
        requestTrigger: trigger
      })
    });

    await transport.sendMessages({
      chatId: "chat-1",
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "regenerate-message"
    });

    const outer = JSON.parse(agent.sent[0]);
    const body = JSON.parse(outer.init.body);

    // trigger from the transport itself
    expect(body.trigger).toBe("regenerate-message");
    // extra fields from prepareBody
    expect(body.model).toBe("gpt-4");
    expect(body.requestTrigger).toBe("regenerate-message");
  });
});
