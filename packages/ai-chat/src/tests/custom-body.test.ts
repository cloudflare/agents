import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

describe("Custom body forwarding to onChatMessage", () => {
  it("should forward custom body fields from the request to onChatMessage options", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.clearCapturedContext();

    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    // Send a chat message with custom body fields
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [userMessage],
            model: "gpt-4",
            temperature: 0.7,
            customField: "custom-value"
          })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    // Wait a bit for the handler to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const capturedBody = await agentStub.getCapturedBody();

    expect(capturedBody).toBeDefined();
    expect(capturedBody).toEqual({
      model: "gpt-4",
      temperature: 0.7,
      customField: "custom-value"
    });

    ws.close(1000);
  });

  it("should not include messages or clientTools in body", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.clearCapturedContext();

    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    // Send a message with clientTools and custom fields
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req2",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [userMessage],
            clientTools: [{ name: "testTool", description: "A test tool" }],
            extraData: "should-be-in-body"
          })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const capturedBody = await agentStub.getCapturedBody();

    expect(capturedBody).toBeDefined();
    // Should only contain extraData, not messages or clientTools
    expect(capturedBody).toEqual({ extraData: "should-be-in-body" });
    expect(capturedBody).not.toHaveProperty("messages");
    expect(capturedBody).not.toHaveProperty("clientTools");

    ws.close(1000);
  });

  it("should set body to undefined when no custom fields are present", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.clearCapturedContext();

    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    });

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    // Send a message with only messages (no custom fields)
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req3",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [userMessage]
          })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const capturedBody = await agentStub.getCapturedBody();

    // When there are no custom fields, body should be undefined
    expect(capturedBody).toBeUndefined();

    ws.close(1000);
  });
});
