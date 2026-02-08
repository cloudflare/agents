import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";

describe("Client Tools Broadcast", () => {
  it("should not broadcast CF_AGENT_CHAT_MESSAGES back to the originating connection after chat request", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const receivedMessages: Array<{ type: string; [key: string]: unknown }> =
      [];
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      receivedMessages.push(data);

      // Wait for the response to complete
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        // Give a small delay to catch any broadcast that might follow
        setTimeout(() => {
          clearTimeout(timeout);
          resolvePromise(true);
        }, 100);
      }
    });

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    // Send chat request from the client
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

    // The originating connection should NOT receive CF_AGENT_CHAT_MESSAGES
    // It should only receive CF_AGENT_USE_CHAT_RESPONSE messages
    const chatMessagesReceived = receivedMessages.filter(
      (m) => m.type === MessageType.CF_AGENT_CHAT_MESSAGES
    );

    // This is the bug: the originating connection receives CF_AGENT_CHAT_MESSAGES
    // which causes duplicate messages when combined with the stream response
    expect(chatMessagesReceived.length).toBe(0);

    ws.close();
  });

  it("should broadcast CF_AGENT_CHAT_MESSAGES to other connections but not the originator", async () => {
    const room = crypto.randomUUID();

    // Connect two clients to the same room
    const { ws: ws1 } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: ws2 } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const ws1Messages: Array<{ type: string; [key: string]: unknown }> = [];
    const ws2Messages: Array<{ type: string; [key: string]: unknown }> = [];

    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws1.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      ws1Messages.push(data);

      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        setTimeout(() => {
          clearTimeout(timeout);
          resolvePromise(true);
        }, 100);
      }
    });

    ws2.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      ws2Messages.push(data);
    });

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    // WS1 sends the chat request
    ws1.send(
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

    // WS1 (originator) should NOT receive CF_AGENT_CHAT_MESSAGES
    const ws1ChatMessages = ws1Messages.filter(
      (m) => m.type === MessageType.CF_AGENT_CHAT_MESSAGES
    );
    expect(ws1ChatMessages.length).toBe(0);

    // WS2 (other connection) SHOULD receive CF_AGENT_CHAT_MESSAGES
    const ws2ChatMessages = ws2Messages.filter(
      (m) => m.type === MessageType.CF_AGENT_CHAT_MESSAGES
    );
    expect(ws2ChatMessages.length).toBeGreaterThan(0);

    ws1.close();
    ws2.close();
  });
});
