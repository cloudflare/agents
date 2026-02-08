import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

describe("Non-SSE Response Handling - PR #761", () => {
  it("should send text-start, text-delta, and text-end events for plain text responses", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const messages: unknown[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string);
        messages.push(data);
        if (
          data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          data.done === true
        ) {
          clearTimeout(timeout);
          resolvePromise(true);
        }
      } catch {
        messages.push(e.data);
      }
    });

    // Wait for initial connection messages
    await new Promise((r) => setTimeout(r, 50));

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    // Send a chat message - TestChatAgent returns plain text response
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    // Filter to only chat response messages
    const chatResponses = messages.filter(isUseChatResponseMessage);

    // Should have at least 4 messages:
    // 1. text-start
    // 2. text-delta (with the actual content)
    // 3. text-end
    // 4. done: true (final completion signal)
    expect(chatResponses.length).toBeGreaterThanOrEqual(4);

    // Parse the bodies to check event types
    const eventTypes = chatResponses
      .filter((m) => m.body && m.body.length > 0)
      .map((m) => {
        try {
          return JSON.parse(m.body);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Check for text-start event
    const textStartEvent = eventTypes.find((e) => e.type === "text-start");
    expect(textStartEvent).toBeDefined();
    expect(textStartEvent.id).toBe("req1");

    // Check for text-delta event with content
    const textDeltaEvent = eventTypes.find((e) => e.type === "text-delta");
    expect(textDeltaEvent).toBeDefined();
    expect(textDeltaEvent.id).toBe("req1");
    expect(textDeltaEvent.delta).toBe("Hello from chat agent!");

    // Check for text-end event
    const textEndEvent = eventTypes.find((e) => e.type === "text-end");
    expect(textEndEvent).toBeDefined();
    expect(textEndEvent.id).toBe("req1");

    // Verify order: text-start comes before text-delta, text-delta comes before text-end
    const startIndex = eventTypes.findIndex((e) => e.type === "text-start");
    const deltaIndex = eventTypes.findIndex((e) => e.type === "text-delta");
    const endIndex = eventTypes.findIndex((e) => e.type === "text-end");

    expect(startIndex).toBeLessThan(deltaIndex);
    expect(deltaIndex).toBeLessThan(endIndex);

    // Check final done message
    const doneMessage = chatResponses.find((m) => m.done === true);
    expect(doneMessage).toBeDefined();

    ws.close();
  });

  it("should use consistent id across text-start, text-delta, and text-end events", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const messages: unknown[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string);
        messages.push(data);
        if (
          data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          data.done === true
        ) {
          clearTimeout(timeout);
          resolvePromise(true);
        }
      } catch {
        messages.push(e.data);
      }
    });

    await new Promise((r) => setTimeout(r, 50));

    const requestId = "test-request-id-123";
    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Test" }]
    };

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: requestId,
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );

    await donePromise;

    const chatResponses = messages.filter(isUseChatResponseMessage);
    const eventTypes = chatResponses
      .filter((m) => m.body && m.body.length > 0)
      .map((m) => {
        try {
          return JSON.parse(m.body);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // All events should have the same request id
    const textEvents = eventTypes.filter((e) =>
      ["text-start", "text-delta", "text-end"].includes(e.type)
    );

    expect(textEvents.length).toBeGreaterThanOrEqual(3);
    for (const event of textEvents) {
      expect(event.id).toBe(requestId);
    }

    ws.close();
  });
});
