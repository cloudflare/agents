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

    ws.close();
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

    ws.close();
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

    ws.close();
  });

  it("should forward stored body to onChatMessage during tool continuation", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.clearCapturedContext();

    // Step 1: Send initial chat request WITH custom body fields to store them
    let resolvePromise: (value: boolean) => void;
    let donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    let timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", function handler(e: MessageEvent) {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
        ws.removeEventListener("message", handler);
      }
    });

    const userMessage: ChatMessage = {
      id: "msg1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

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

    let done = await donePromise;
    expect(done).toBe(true);

    // Verify initial request received the body
    await new Promise((resolve) => setTimeout(resolve, 100));
    const initialBody = await agentStub.getCapturedBody();
    expect(initialBody).toEqual({
      model: "gpt-4",
      temperature: 0.7,
      customField: "custom-value"
    });

    // Step 2: Persist a tool call in input-available state
    const toolCallId = "call_body_continuation_test";
    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId,
            state: "input-available",
            input: { param: "value" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    // Step 3: Clear captured state before continuation
    await agentStub.clearCapturedContext();

    // Step 4: Send tool result with autoContinue to trigger continuation
    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: { success: true },
        autoContinue: true
      })
    );

    // Wait for continuation (500ms stream wait + processing)
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 5: Verify continuation received the stored body
    const continuationBody = await agentStub.getCapturedBody();
    expect(continuationBody).toBeDefined();
    expect(continuationBody).toEqual({
      model: "gpt-4",
      temperature: 0.7,
      customField: "custom-value"
    });

    ws.close();
  });

  it("should clear stored body when chat is cleared", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Send initial request with custom body to store it
    let resolvePromise: (value: boolean) => void;
    const donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });

    const timeout = setTimeout(() => resolvePromise(false), 2000);

    ws.addEventListener("message", function handler(e: MessageEvent) {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
        ws.removeEventListener("message", handler);
      }
    });

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "msg1",
                role: "user",
                parts: [{ type: "text", text: "Hi" }]
              }
            ],
            model: "gpt-4",
            temperature: 0.5
          })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

    // Verify body was stored
    await new Promise((resolve) => setTimeout(resolve, 100));
    const storedBody = await agentStub.getCapturedBody();
    expect(storedBody).toEqual({ model: "gpt-4", temperature: 0.5 });

    // Clear chat
    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Persist a tool call and trigger continuation
    await agentStub.persistMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Execute tool" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId: "call_after_clear",
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      }
    ]);

    await agentStub.clearCapturedContext();

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId: "call_after_clear",
        toolName: "testTool",
        output: { success: true },
        autoContinue: true
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Body should be undefined after chat clear
    const continuationBody = await agentStub.getCapturedBody();
    expect(continuationBody).toBeUndefined();

    ws.close();
  });

  it("should update stored body when new request has different body", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.clearCapturedContext();

    // Send first request WITH custom body
    let resolvePromise: (value: boolean) => void;
    let donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });
    let timeout = setTimeout(() => resolvePromise(false), 2000);

    const handler1 = (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    };
    ws.addEventListener("message", handler1);

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "msg1",
                role: "user",
                parts: [{ type: "text", text: "Hi" }]
              }
            ],
            model: "gpt-4",
            temperature: 0.7
          })
        }
      })
    );

    let done = await donePromise;
    expect(done).toBe(true);
    ws.removeEventListener("message", handler1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    let capturedBody = await agentStub.getCapturedBody();
    expect(capturedBody).toEqual({ model: "gpt-4", temperature: 0.7 });

    // Send second request with DIFFERENT body (e.g., user changed model)
    donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });
    timeout = setTimeout(() => resolvePromise(false), 2000);

    const handler2 = (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    };
    ws.addEventListener("message", handler2);

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req2",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "msg1",
                role: "user",
                parts: [{ type: "text", text: "Hi" }]
              },
              {
                id: "msg2",
                role: "user",
                parts: [{ type: "text", text: "Use a different model" }]
              }
            ],
            model: "claude-3",
            temperature: 0.9
          })
        }
      })
    );

    done = await donePromise;
    expect(done).toBe(true);
    ws.removeEventListener("message", handler2);

    await new Promise((resolve) => setTimeout(resolve, 100));
    capturedBody = await agentStub.getCapturedBody();
    expect(capturedBody).toEqual({ model: "claude-3", temperature: 0.9 });

    // Now trigger a tool continuation - it should use the LATEST body
    const toolCallId = "call_updated_body_test";
    await agentStub.persistMessages([
      {
        id: "msg1",
        role: "user",
        parts: [{ type: "text", text: "Hi" }]
      },
      {
        id: "msg2",
        role: "user",
        parts: [{ type: "text", text: "Use a different model" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId,
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      }
    ]);

    await agentStub.clearCapturedContext();

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: { success: true },
        autoContinue: true
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Continuation should use the latest body from the second request
    const continuationBody = await agentStub.getCapturedBody();
    expect(continuationBody).toEqual({ model: "claude-3", temperature: 0.9 });

    ws.close();
  });

  it("should clear stored body when new request has no custom fields", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.clearCapturedContext();

    // Send first request WITH custom body
    let resolvePromise: (value: boolean) => void;
    let donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });
    let timeout = setTimeout(() => resolvePromise(false), 2000);

    const handler1 = (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    };
    ws.addEventListener("message", handler1);

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "msg1",
                role: "user",
                parts: [{ type: "text", text: "Hi" }]
              }
            ],
            model: "gpt-4"
          })
        }
      })
    );

    let done = await donePromise;
    expect(done).toBe(true);
    ws.removeEventListener("message", handler1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    let capturedBody = await agentStub.getCapturedBody();
    expect(capturedBody).toEqual({ model: "gpt-4" });

    // Send second request WITHOUT custom fields
    donePromise = new Promise<boolean>((res) => {
      resolvePromise = res;
    });
    timeout = setTimeout(() => resolvePromise(false), 2000);

    const handler2 = (e: MessageEvent) => {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(timeout);
        resolvePromise(true);
      }
    };
    ws.addEventListener("message", handler2);

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req2",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: "msg1",
                role: "user",
                parts: [{ type: "text", text: "Hi" }]
              },
              {
                id: "msg2",
                role: "user",
                parts: [{ type: "text", text: "Again" }]
              }
            ]
            // No custom fields
          })
        }
      })
    );

    done = await donePromise;
    expect(done).toBe(true);
    ws.removeEventListener("message", handler2);

    await new Promise((resolve) => setTimeout(resolve, 100));
    capturedBody = await agentStub.getCapturedBody();
    expect(capturedBody).toBeUndefined();

    // Tool continuation should also have undefined body
    const toolCallId = "call_no_body_test";
    await agentStub.persistMessages([
      {
        id: "msg1",
        role: "user",
        parts: [{ type: "text", text: "Hi" }]
      },
      {
        id: "msg2",
        role: "user",
        parts: [{ type: "text", text: "Again" }]
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-testTool",
            toolCallId,
            state: "input-available",
            input: {}
          }
        ] as ChatMessage["parts"]
      }
    ]);

    await agentStub.clearCapturedContext();

    ws.send(
      JSON.stringify({
        type: "cf_agent_tool_result",
        toolCallId,
        toolName: "testTool",
        output: { success: true },
        autoContinue: true
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const continuationBody = await agentStub.getCapturedBody();
    expect(continuationBody).toBeUndefined();

    ws.close();
  });
});
