import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { getAgentByName } from "agents";

describe("Plain text response handling", () => {
  it("produces a single text part for plain text responses", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const messages: unknown[] = [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      messages.push(data);

      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    // Send a chat request - the test worker returns plain text "Hello from chat agent!"
    const userMessage: ChatMessage = {
      id: "msg-plain-1",
      role: "user",
      parts: [{ type: "text", text: "Test" }]
    };

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-plain-1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage] })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    // Verify the persisted message has a single text part (not multiple)
    const agentStub = await getAgentByName(env.TestChatAgent, room);
    const persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];

    const assistantMessages = persisted.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    // The last assistant message should have exactly 1 text part
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const textParts = lastAssistant.parts.filter((p) => p.type === "text");
    expect(textParts.length).toBe(1);

    // The text should be the full response content
    const textPart = textParts[0] as { text: string };
    expect(textPart.text).toBe("Hello from chat agent!");

    // Verify the stream protocol events: text-start, text-delta(s), text-end
    const streamResponses = messages.filter(isUseChatResponseMessage);
    const nonEmptyResponses = streamResponses.filter(
      (m) =>
        "body" in m && typeof m.body === "string" && m.body.trim().length > 0
    );

    // Should have text-start, text-delta(s), text-end events
    const bodies = nonEmptyResponses.map((m) => JSON.parse(m.body as string));
    const types = bodies.map((b) => b.type);

    expect(types[0]).toBe("text-start");
    expect(types[types.length - 1]).toBe("text-end");
    expect(
      types.filter((t: string) => t === "text-delta").length
    ).toBeGreaterThanOrEqual(1);

    ws.close(1000);
  });
});
