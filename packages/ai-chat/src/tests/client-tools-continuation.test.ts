import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { MessageType } from "../types";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";

function collectMessages(ws: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    const data = JSON.parse(e.data as string);
    if (typeof data === "object" && data !== null) {
      messages.push(data as Record<string, unknown>);
    }
  });
  return messages;
}

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 3000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = messages.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

describe("Client tools continuation", () => {
  it("should pass client tools to onChatMessage during auto-continuation", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.clearCapturedContext();

    // Step 1: Send initial chat request WITH client tools to store them
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

    const clientTools = [
      {
        name: "changeBackgroundColor",
        description: "Changes the background color",
        parameters: {
          type: "object",
          properties: { color: { type: "string" } }
        }
      },
      {
        name: "changeTextColor",
        description: "Changes the text color",
        parameters: {
          type: "object",
          properties: { color: { type: "string" } }
        }
      }
    ];

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req1",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage], clientTools })
        }
      })
    );

    let done = await donePromise;
    expect(done).toBe(true);

    // Verify initial request received client tools
    await new Promise((resolve) => setTimeout(resolve, 100));
    const initialClientTools = await agentStub.getCapturedClientTools();
    expect(initialClientTools).toBeDefined();
    expect(initialClientTools).toHaveLength(2);

    // Step 2: Persist a tool call in input-available state
    const toolCallId = "call_continuation_test";
    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-changeBackgroundColor",
            toolCallId,
            state: "input-available",
            input: { color: "green" }
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
        toolName: "changeBackgroundColor",
        output: { success: true },
        autoContinue: true
      })
    );

    // Wait for continuation (500ms stream wait + processing)
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Step 5: Verify continuation received client tools
    const continuationClientTools = await agentStub.getCapturedClientTools();
    expect(continuationClientTools).toBeDefined();
    expect(continuationClientTools).toHaveLength(2);
    expect(continuationClientTools).toEqual(clientTools);

    ws.close(1000);
  });

  it("should allow resume requests to wait for pending auto-continuations", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const userMessage: ChatMessage = {
      id: "msg-pending",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    let initialResolvePromise: (value: boolean) => void;
    const initialDonePromise = new Promise<boolean>((res) => {
      initialResolvePromise = res;
    });

    const initialTimeout = setTimeout(() => initialResolvePromise(false), 3000);

    ws.addEventListener("message", function initialHandler(e: MessageEvent) {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(initialTimeout);
        initialResolvePromise(true);
        ws.removeEventListener("message", initialHandler);
      }
    });

    // Send an initial request with delayMs so the stored body makes the
    // continuation wait long enough for the client to request a resume.
    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-pending",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage], delayMs: 150 })
        }
      })
    );

    const initialDone = await initialDonePromise;
    expect(initialDone).toBe(true);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-pending",
        role: "assistant",
        parts: [
          {
            type: "tool-changeBackgroundColor",
            toolCallId: "call_pending_resume",
            state: "input-available",
            input: { color: "blue" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const receivedMessages: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      receivedMessages.push(JSON.parse(e.data as string));
    });

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_pending_resume",
        toolName: "changeBackgroundColor",
        output: { success: true },
        autoContinue: true
      })
    );

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST
      })
    );

    const waitForMessage = async (
      predicate: (message: Record<string, unknown>) => boolean,
      timeoutMs = 3000
    ) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const match = receivedMessages.find(predicate);
        if (match) {
          return match;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return undefined;
    };

    const resumingMessage = (await waitForMessage(
      (message) => message.type === MessageType.CF_AGENT_STREAM_RESUMING
    )) as { id: string } | undefined;

    const noneMessages = receivedMessages.filter(
      (message) => message.type === MessageType.CF_AGENT_STREAM_RESUME_NONE
    );
    expect(noneMessages).toHaveLength(0);
    expect(resumingMessage).toBeDefined();

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
        id: resumingMessage!.id
      })
    );

    const doneMessage = await waitForMessage(
      (message) =>
        message.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
        message.done === true
    );
    expect(doneMessage).toBeDefined();

    ws.close(1000);
  });

  it("should keep other tabs on live broadcast during tool-result auto-continuation", async () => {
    const room = crypto.randomUUID();
    const { ws: wsA } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: wsB } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    try {
      const userMessage: ChatMessage = {
        id: "msg-multi-tab-tool-result",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      };

      let resolveInitialDone: (value: boolean) => void;
      const initialDonePromise = new Promise<boolean>((res) => {
        resolveInitialDone = res;
      });

      const initialTimeout = setTimeout(() => resolveInitialDone(false), 3000);

      wsA.addEventListener("message", function initialHandler(e: MessageEvent) {
        const data = JSON.parse(e.data as string);
        if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
          clearTimeout(initialTimeout);
          resolveInitialDone(true);
          wsA.removeEventListener("message", initialHandler);
        }
      });

      wsA.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
          id: "req-multi-tab-tool-result",
          init: {
            method: "POST",
            body: JSON.stringify({ messages: [userMessage], delayMs: 300 })
          }
        })
      );

      const initialDone = await initialDonePromise;
      expect(initialDone).toBe(true);

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      await agentStub.persistMessages([
        userMessage,
        {
          id: "assistant-multi-tab-tool-result",
          role: "assistant",
          parts: [
            {
              type: "tool-changeBackgroundColor",
              toolCallId: "call_multi_tab_tool_result",
              state: "input-available",
              input: { color: "blue" }
            }
          ] as ChatMessage["parts"]
        }
      ]);

      const receivedMessagesA = collectMessages(wsA);
      const receivedMessagesB = collectMessages(wsB);

      wsA.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_TOOL_RESULT,
          toolCallId: "call_multi_tab_tool_result",
          toolName: "changeBackgroundColor",
          output: { success: true },
          autoContinue: true
        })
      );

      wsA.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST
        })
      );

      wsB.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST
        })
      );

      const resumingA = (await waitForMessage(
        receivedMessagesA,
        (message) => message.type === MessageType.CF_AGENT_STREAM_RESUMING
      )) as { id: string } | undefined;
      expect(resumingA).toBeDefined();

      const noneB = await waitForMessage(
        receivedMessagesB,
        (message) => message.type === MessageType.CF_AGENT_STREAM_RESUME_NONE
      );
      expect(noneB).toBeDefined();
      expect(
        receivedMessagesB.find(
          (message) => message.type === MessageType.CF_AGENT_STREAM_RESUMING
        )
      ).toBeUndefined();

      wsA.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_ACK,
          id: resumingA!.id
        })
      );

      const streamedChunkB = await waitForMessage(
        receivedMessagesB,
        (message) =>
          message.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          message.done !== true
      );
      expect(streamedChunkB).toBeDefined();

      const doneB = await waitForMessage(
        receivedMessagesB,
        (message) =>
          message.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          message.done === true
      );
      expect(doneB).toBeDefined();
    } finally {
      wsA.close(1000);
      wsB.close(1000);
    }
  });

  it("should keep other tabs on live broadcast during tool-approval auto-continuation", async () => {
    const room = crypto.randomUUID();
    const { ws: wsA } = await connectChatWS(`/agents/test-chat-agent/${room}`);
    const { ws: wsB } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    try {
      const userMessage: ChatMessage = {
        id: "msg-multi-tab-tool-approval",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      };

      let resolveInitialDone: (value: boolean) => void;
      const initialDonePromise = new Promise<boolean>((res) => {
        resolveInitialDone = res;
      });

      const initialTimeout = setTimeout(() => resolveInitialDone(false), 3000);

      wsA.addEventListener("message", function initialHandler(e: MessageEvent) {
        const data = JSON.parse(e.data as string);
        if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
          clearTimeout(initialTimeout);
          resolveInitialDone(true);
          wsA.removeEventListener("message", initialHandler);
        }
      });

      wsA.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
          id: "req-multi-tab-tool-approval",
          init: {
            method: "POST",
            body: JSON.stringify({ messages: [userMessage], delayMs: 300 })
          }
        })
      );

      const initialDone = await initialDonePromise;
      expect(initialDone).toBe(true);

      const agentStub = await getAgentByName(env.TestChatAgent, room);
      await agentStub.persistMessages([
        userMessage,
        {
          id: "assistant-multi-tab-tool-approval",
          role: "assistant",
          parts: [
            {
              type: "tool-changeBackgroundColor",
              toolCallId: "call_multi_tab_tool_approval",
              state: "approval-requested",
              input: { color: "blue" },
              approval: { id: "approval_multi_tab_tool_approval" }
            }
          ] as ChatMessage["parts"]
        }
      ]);

      const receivedMessagesB = collectMessages(wsB);

      wsA.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_TOOL_APPROVAL,
          toolCallId: "call_multi_tab_tool_approval",
          approved: true,
          autoContinue: true
        })
      );

      wsB.send(
        JSON.stringify({
          type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST
        })
      );

      const noneB = await waitForMessage(
        receivedMessagesB,
        (message) => message.type === MessageType.CF_AGENT_STREAM_RESUME_NONE
      );
      expect(noneB).toBeDefined();
      expect(
        receivedMessagesB.find(
          (message) => message.type === MessageType.CF_AGENT_STREAM_RESUMING
        )
      ).toBeUndefined();

      const streamedChunkB = await waitForMessage(
        receivedMessagesB,
        (message) =>
          message.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          message.done !== true
      );
      expect(streamedChunkB).toBeDefined();

      const doneB = await waitForMessage(
        receivedMessagesB,
        (message) =>
          message.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          message.done === true
      );
      expect(doneB).toBeDefined();
    } finally {
      wsA.close(1000);
      wsB.close(1000);
    }
  });

  it("should send resume-none when an auto-continuation returns no body", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const userMessage: ChatMessage = {
      id: "msg-no-body",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    let initialResolvePromise: (value: boolean) => void;
    const initialDonePromise = new Promise<boolean>((res) => {
      initialResolvePromise = res;
    });

    const initialTimeout = setTimeout(() => initialResolvePromise(false), 3000);

    ws.addEventListener("message", function initialHandler(e: MessageEvent) {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(initialTimeout);
        initialResolvePromise(true);
        ws.removeEventListener("message", initialHandler);
      }
    });

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-no-body",
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [userMessage],
            delayMs: 150,
            emptyContinuationResponse: true
          })
        }
      })
    );

    const initialDone = await initialDonePromise;
    expect(initialDone).toBe(true);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-no-body",
        role: "assistant",
        parts: [
          {
            type: "tool-changeBackgroundColor",
            toolCallId: "call_no_body_resume",
            state: "input-available",
            input: { color: "blue" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const receivedMessages: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      receivedMessages.push(JSON.parse(e.data as string));
    });

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_no_body_resume",
        toolName: "changeBackgroundColor",
        output: { success: true },
        autoContinue: true
      })
    );

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST
      })
    );

    const waitForMessage = async (
      predicate: (message: Record<string, unknown>) => boolean,
      timeoutMs = 3000
    ) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const match = receivedMessages.find(predicate);
        if (match) {
          return match;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return undefined;
    };

    const noneMessage = await waitForMessage(
      (message) => message.type === MessageType.CF_AGENT_STREAM_RESUME_NONE
    );
    expect(noneMessage).toBeDefined();

    const resumingMessage = receivedMessages.find(
      (message) => message.type === MessageType.CF_AGENT_STREAM_RESUMING
    );
    expect(resumingMessage).toBeUndefined();

    ws.close(1000);
  });

  it("should clear stored client tools when chat is cleared", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Send initial request with client tools to store them
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
            clientTools: [{ name: "testTool", description: "Test" }]
          })
        }
      })
    );

    const done = await donePromise;
    expect(done).toBe(true);

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

    // Client tools should be undefined after chat clear
    const continuationClientTools = await agentStub.getCapturedClientTools();
    expect(continuationClientTools).toBeUndefined();

    ws.close(1000);
  });

  it("sends STREAM_RESUME_NONE when chat clear cancels a pending tool continuation", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const userMessage: ChatMessage = {
      id: "msg-clear-pending",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    let initialResolvePromise: (value: boolean) => void;
    const initialDonePromise = new Promise<boolean>((res) => {
      initialResolvePromise = res;
    });

    const initialTimeout = setTimeout(() => initialResolvePromise(false), 3000);

    ws.addEventListener("message", function initialHandler(e: MessageEvent) {
      const data = JSON.parse(e.data as string);
      if (data.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE && data.done) {
        clearTimeout(initialTimeout);
        initialResolvePromise(true);
        ws.removeEventListener("message", initialHandler);
      }
    });

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
        id: "req-clear-pending",
        init: {
          method: "POST",
          body: JSON.stringify({ messages: [userMessage], delayMs: 150 })
        }
      })
    );

    const initialDone = await initialDonePromise;
    expect(initialDone).toBe(true);

    const agentStub = await getAgentByName(env.TestChatAgent, room);
    await agentStub.persistMessages([
      userMessage,
      {
        id: "assistant-clear-pending",
        role: "assistant",
        parts: [
          {
            type: "tool-changeBackgroundColor",
            toolCallId: "call_clear_pending_resume",
            state: "input-available",
            input: { color: "blue" }
          }
        ] as ChatMessage["parts"]
      }
    ]);

    const receivedMessages: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      receivedMessages.push(JSON.parse(e.data as string));
    });

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId: "call_clear_pending_resume",
        toolName: "changeBackgroundColor",
        output: { success: true },
        autoContinue: true
      })
    );

    ws.send(
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUME_REQUEST
      })
    );

    ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));

    const waitForMessage = async (
      predicate: (message: Record<string, unknown>) => boolean,
      timeoutMs = 3000
    ) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const match = receivedMessages.find(predicate);
        if (match) {
          return match;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return undefined;
    };

    const noneMessage = await waitForMessage(
      (message) => message.type === MessageType.CF_AGENT_STREAM_RESUME_NONE
    );
    expect(noneMessage).toBeDefined();

    ws.close(1000);
  });

  it("should clear stored client tools when new request has no client tools", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);

    const agentStub = await getAgentByName(env.TestChatAgent, room);

    // Send first request WITH client tools
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
            clientTools: [{ name: "testTool", description: "Test" }]
          })
        }
      })
    );

    let done = await donePromise;
    expect(done).toBe(true);
    ws.removeEventListener("message", handler1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    let capturedTools = await agentStub.getCapturedClientTools();
    expect(capturedTools).toHaveLength(1);

    // Send second request WITHOUT client tools
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
            // No clientTools
          })
        }
      })
    );

    done = await donePromise;
    expect(done).toBe(true);
    ws.removeEventListener("message", handler2);

    await new Promise((resolve) => setTimeout(resolve, 100));
    capturedTools = await agentStub.getCapturedClientTools();
    expect(capturedTools).toBeUndefined();

    ws.close(1000);
  });
});
