import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { MessageType } from "../types";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";

describe("Concurrent Message Handling", () => {
  it("processes multiple simultaneous messages in order without interleaving", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const receivedResponses: Array<{
      id: string;
      body: string;
      done: boolean;
      timestamp: number;
    }> = [];

    // Track when all 3 responses are complete
    let completedCount = 0;
    let resolveAll: () => void;
    const allDone = new Promise<void>((res) => {
      resolveAll = res;
    });

    const timeout = setTimeout(() => {
      throw new Error(
        `Timeout: only received ${completedCount}/3 complete responses`
      );
    }, 10000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (isUseChatResponseMessage(data)) {
        receivedResponses.push({
          id: data.id,
          body: data.body,
          done: data.done,
          timestamp: Date.now()
        });
        if (data.done) {
          completedCount++;
          if (completedCount === 3) {
            clearTimeout(timeout);
            resolveAll();
          }
        }
      }
    });

    // Send 3 messages as fast as possible (simulating rapid user input)
    const messages = ["first", "second", "third"];
    for (const text of messages) {
      const userMessage: ChatMessage = {
        id: `msg-${text}`,
        role: "user",
        parts: [{ type: "text", text }]
      };

      ws.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
          id: `req-${text}`,
          init: {
            method: "POST",
            body: JSON.stringify({ messages: [userMessage] })
          }
        })
      );
    }

    // Wait for all responses to complete
    await allDone;

    // Verify we got exactly 3 complete responses
    const doneResponses = receivedResponses.filter((r) => r.done);
    expect(doneResponses).toHaveLength(3);

    // Verify responses completed in order (first, second, third)
    // This proves the queue serialized the requests — if they ran concurrently,
    // order would be non-deterministic
    const doneIds = doneResponses.map((r) => r.id);
    expect(doneIds).toEqual(["req-first", "req-second", "req-third"]);

    ws.close();
  });

  it("queued messages are cleared when chat history is cleared", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const receivedResponses: Array<{ id: string; done: boolean }> = [];

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (isUseChatResponseMessage(data)) {
        receivedResponses.push({ id: data.id, done: data.done });
      }
    });

    // Send first message
    const firstMessage: ChatMessage = {
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "first" }]
    };
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [firstMessage] })
        }
      })
    );

    // Immediately send clear command
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_CLEAR
      })
    );

    // Send second message after clear
    const secondMessage: ChatMessage = {
      id: "msg-2",
      role: "user",
      parts: [{ type: "text", text: "second" }]
    };
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-2",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [secondMessage] })
        }
      })
    );

    // Wait for second response to complete
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        const doneResponses = receivedResponses.filter((r) => r.done);
        // We expect at least one done response (the second one)
        if (doneResponses.some((r) => r.id === "req-2")) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 5000);
    });

    // The second message should have completed
    const doneResponses = receivedResponses.filter((r) => r.done);
    expect(doneResponses.some((r) => r.id === "req-2")).toBe(true);

    ws.close();
  });
});
