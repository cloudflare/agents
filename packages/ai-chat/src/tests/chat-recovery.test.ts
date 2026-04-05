import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { MessageType } from "../types";

interface ChatTestStub {
  getPersistedMessages(): Promise<ChatMessage[]>;
  getActiveFibers(): Promise<Array<{ id: string; name: string }>>;
  getOnChatMessageCallCount(): Promise<number>;
  getRecoveryContexts(): Promise<
    Array<{ recoveryData: unknown; partialText: string; streamId: string }>
  >;
  waitForIdleForTest(): Promise<void>;
  persistMessages(messages: unknown[]): Promise<void>;
  callContinueLastTurn(
    body?: Record<string, unknown>
  ): Promise<{ requestId: string; status: string }>;
  setStashData(data: unknown): Promise<void>;
  getStashResult(): Promise<{
    success: boolean;
    error?: string;
  } | null>;
  saveSyntheticUserMessage(
    text: string
  ): Promise<{ requestId: string; status: string }>;
  setRecoveryOverride(options: {
    persist?: boolean;
    continue?: boolean;
  }): Promise<void>;
  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>,
    ageMs?: number
  ): Promise<void>;
  insertInterruptedFiber(name: string, snapshot?: unknown): Promise<void>;
  triggerFiberRecovery(): Promise<void>;
}

interface SlowStreamStub {
  getActiveFibers(): Promise<Array<{ id: string; name: string }>>;
  getAbortControllerCount(): Promise<number>;
  waitForIdleForTest(): Promise<boolean>;
}

interface ThrowingStub {
  setShouldThrow(value: boolean): Promise<void>;
  getOnChatMessageCallCount(): Promise<number>;
  getPersistedMessages(): Promise<ChatMessage[]>;
  getActiveFibers(): Promise<Array<{ id: string; name: string }>>;
  getAbortControllerCount(): Promise<number>;
  waitForIdleForTest(): Promise<void>;
}

function sendChatRequest(
  ws: WebSocket,
  requestId: string,
  messages: ChatMessage[],
  extraBody?: Record<string, unknown>
) {
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      id: requestId,
      init: {
        method: "POST",
        body: JSON.stringify({ messages, ...extraBody })
      }
    })
  );
}

function sendCancel(ws: WebSocket, requestId: string) {
  ws.send(
    JSON.stringify({
      type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL,
      id: requestId
    })
  );
}

function waitForDone(ws: WebSocket, timeoutMs = 5000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve(false);
    }, timeoutMs);

    function handler(e: MessageEvent) {
      const data = JSON.parse(e.data as string);
      if (isUseChatResponseMessage(data) && data.done) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(true);
      }
    }

    ws.addEventListener("message", handler);
  });
}

function collectMessages(
  ws: WebSocket,
  timeoutMs = 10000
): Promise<{ messages: unknown[]; timedOut: boolean }> {
  const messages: unknown[] = [];
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve({ messages, timedOut: true });
    }, timeoutMs);

    function handler(e: MessageEvent) {
      const data = JSON.parse(e.data as string);
      messages.push(data);
      if (isUseChatResponseMessage(data) && data.done) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve({ messages, timedOut: false });
      }
    }

    ws.addEventListener("message", handler);
  });
}

function extractAssistantText(messages: ChatMessage[]): string {
  const assistant = messages.find((m) => m.role === "assistant");
  if (!assistant) return "";
  return assistant.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

const userMessage: ChatMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
};

describe("unstable_chatRecovery", () => {
  describe("unstable_chatRecovery=true via WebSocket", () => {
    it("persists messages and cleans up fibers after chat turn", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(
        `/agents/chat-recovery-test-agent/${room}`
      );

      const done = waitForDone(ws);
      sendChatRequest(ws, "req-1", [userMessage]);
      expect(await done).toBe(true);

      const stub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;
      await stub.waitForIdleForTest();

      const messages = await stub.getPersistedMessages();
      const userMsgs = messages.filter((m) => m.role === "user");
      const assistantMsgs = messages.filter((m) => m.role === "assistant");
      expect(userMsgs).toHaveLength(1);
      expect(assistantMsgs).toHaveLength(1);
      expect(extractAssistantText(messages)).toContain("Continued response.");

      const fibers = await stub.getActiveFibers();
      expect(fibers).toHaveLength(0);

      expect(await stub.getOnChatMessageCallCount()).toBe(1);

      ws.close(1000);
    });
  });

  describe("unstable_chatRecovery=false via WebSocket", () => {
    it("persists messages without creating fiber rows or firing recovery", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(
        `/agents/non-chat-recovery-test-agent/${room}`
      );

      const done = waitForDone(ws);
      sendChatRequest(ws, "req-1", [userMessage]);
      expect(await done).toBe(true);

      const stub = (await getAgentByName(
        env.NonChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;
      await stub.waitForIdleForTest();

      const messages = await stub.getPersistedMessages();
      const userMsgs = messages.filter((m) => m.role === "user");
      const assistantMsgs = messages.filter((m) => m.role === "assistant");
      expect(userMsgs).toHaveLength(1);
      expect(assistantMsgs).toHaveLength(1);
      expect(extractAssistantText(messages)).toContain("Continued response.");

      const fibers = await stub.getActiveFibers();
      expect(fibers).toHaveLength(0);

      const recoveryContexts = await stub.getRecoveryContexts();
      expect(recoveryContexts).toHaveLength(0);

      ws.close(1000);
    });
  });

  describe("behavioral parity", () => {
    it("produces equivalent persisted messages regardless of unstable_chatRecovery", async () => {
      const durableRoom = crypto.randomUUID();
      const nonDurableRoom = crypto.randomUUID();

      const { ws: durableWs } = await connectChatWS(
        `/agents/chat-recovery-test-agent/${durableRoom}`
      );
      const { ws: nonDurableWs } = await connectChatWS(
        `/agents/non-chat-recovery-test-agent/${nonDurableRoom}`
      );

      const durableDone = waitForDone(durableWs);
      const nonDurableDone = waitForDone(nonDurableWs);

      sendChatRequest(durableWs, "req-1", [userMessage]);
      sendChatRequest(nonDurableWs, "req-1", [userMessage]);

      expect(await durableDone).toBe(true);
      expect(await nonDurableDone).toBe(true);

      const durableStub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        durableRoom
      )) as unknown as ChatTestStub;
      const nonDurableStub = (await getAgentByName(
        env.NonChatRecoveryTestAgent,
        nonDurableRoom
      )) as unknown as ChatTestStub;

      await durableStub.waitForIdleForTest();
      await nonDurableStub.waitForIdleForTest();

      const durableMessages = await durableStub.getPersistedMessages();
      const nonDurableMessages = await nonDurableStub.getPersistedMessages();

      expect(durableMessages.length).toBe(nonDurableMessages.length);
      expect(durableMessages.map((m) => m.role)).toEqual(
        nonDurableMessages.map((m) => m.role)
      );

      expect(durableMessages.filter((m) => m.role === "user")).toHaveLength(1);
      expect(
        durableMessages.filter((m) => m.role === "assistant")
      ).toHaveLength(1);

      const durableText = extractAssistantText(durableMessages);
      const nonDurableText = extractAssistantText(nonDurableMessages);
      expect(durableText).toBe(nonDurableText);

      expect(await durableStub.getOnChatMessageCallCount()).toBe(1);
      expect(await nonDurableStub.getOnChatMessageCallCount()).toBe(1);

      durableWs.close(1000);
      nonDurableWs.close(1000);
    });
  });

  describe("continueLastTurn with unstable_chatRecovery=false", () => {
    it("appends to the last assistant message without fiber wrapping", async () => {
      const room = crypto.randomUUID();
      const stub = (await getAgentByName(
        env.NonChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;

      await stub.persistMessages([
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Tell me a story" }]
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Once upon a time" }]
        }
      ] as ChatMessage[]);

      await stub.callContinueLastTurn();
      await stub.waitForIdleForTest();

      const messages = await stub.getPersistedMessages();

      const userMsgs = messages.filter((m) => m.role === "user");
      const assistantMsgs = messages.filter((m) => m.role === "assistant");
      expect(userMsgs).toHaveLength(1);
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0].id).toBe("assistant-1");

      const allText = assistantMsgs[0].parts
        .filter((p: ChatMessage["parts"][number]) => p.type === "text")
        .map((p: { type: string; text?: string }) => p.text ?? "")
        .join("");
      expect(allText).toContain("Once upon a time");
      expect(allText).toContain("Continued response.");

      const fibers = await stub.getActiveFibers();
      expect(fibers).toHaveLength(0);

      expect(await stub.getOnChatMessageCallCount()).toBe(1);
    });

    it("skips when there is no assistant message", async () => {
      const room = crypto.randomUUID();
      const stub = (await getAgentByName(
        env.NonChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;

      await stub.persistMessages([
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        }
      ] as ChatMessage[]);

      const result = await stub.callContinueLastTurn();
      expect(result.status).toBe("skipped");
      expect(await stub.getOnChatMessageCallCount()).toBe(0);
    });
  });

  describe("error handling with unstable_chatRecovery=true", () => {
    it("cleans up fibers and abort controllers when onChatMessage throws", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(
        `/agents/recovery-throwing-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const stub = (await getAgentByName(
        env.RecoveryThrowingAgent,
        room
      )) as unknown as ThrowingStub;
      await stub.setShouldThrow(true);

      sendChatRequest(ws, "req-err", [userMessage]);

      await new Promise((r) => setTimeout(r, 200));
      await stub.waitForIdleForTest();

      expect(await stub.getOnChatMessageCallCount()).toBe(1);

      const fibers = await stub.getActiveFibers();
      expect(fibers).toHaveLength(0);

      const abortCount = await stub.getAbortControllerCount();
      expect(abortCount).toBe(0);

      ws.close(1000);
    });

    it("still works for subsequent requests after an error", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(
        `/agents/recovery-throwing-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const stub = (await getAgentByName(
        env.RecoveryThrowingAgent,
        room
      )) as unknown as ThrowingStub;

      // First request: throw
      await stub.setShouldThrow(true);
      sendChatRequest(ws, "req-fail", [userMessage]);
      await new Promise((r) => setTimeout(r, 200));
      await stub.waitForIdleForTest();

      expect(await stub.getAbortControllerCount()).toBe(0);

      // Second request: succeed
      await stub.setShouldThrow(false);
      const secondDone = waitForDone(ws);
      sendChatRequest(ws, "req-ok", [userMessage]);
      expect(await secondDone).toBe(true);
      await stub.waitForIdleForTest();

      expect(await stub.getOnChatMessageCallCount()).toBe(2);

      const messages = await stub.getPersistedMessages();
      const assistantMsgs = messages.filter((m) => m.role === "assistant");
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

      const fibers = await stub.getActiveFibers();
      expect(fibers).toHaveLength(0);

      const abortCount = await stub.getAbortControllerCount();
      expect(abortCount).toBe(0);

      ws.close(1000);
    });
  });

  describe("multiple consecutive WS turns with unstable_chatRecovery=true", () => {
    it("handles sequential chat turns without fiber leaks", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(
        `/agents/chat-recovery-test-agent/${room}`
      );

      const msg1: ChatMessage = {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "First message" }]
      };

      const firstDone = waitForDone(ws);
      sendChatRequest(ws, "req-1", [msg1]);
      expect(await firstDone).toBe(true);

      const stub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;
      await stub.waitForIdleForTest();

      // Fetch the assistant reply from the first turn to include in
      // the second request (mirrors real AI SDK client behavior)
      const midMessages = await stub.getPersistedMessages();
      const firstAssistant = midMessages.find((m) => m.role === "assistant")!;

      const msg2: ChatMessage = {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Second message" }]
      };

      const secondDone = waitForDone(ws);
      sendChatRequest(ws, "req-2", [msg1, firstAssistant, msg2]);
      expect(await secondDone).toBe(true);
      await stub.waitForIdleForTest();

      const messages = await stub.getPersistedMessages();
      const userMsgs = messages.filter((m) => m.role === "user");
      const assistantMsgs = messages.filter((m) => m.role === "assistant");
      expect(userMsgs).toHaveLength(2);
      expect(assistantMsgs).toHaveLength(2);

      const fibers = await stub.getActiveFibers();
      expect(fibers).toHaveLength(0);

      expect(await stub.getOnChatMessageCallCount()).toBe(2);

      ws.close(1000);
    });
  });

  describe("stash() integration", () => {
    it("stash() is callable from onChatMessage during a durable chat turn", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(
        `/agents/chat-recovery-test-agent/${room}`
      );

      const stub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;

      await stub.setStashData({
        responseId: "resp-123",
        provider: "openai"
      });

      const done = waitForDone(ws);
      sendChatRequest(ws, "req-1", [userMessage]);
      expect(await done).toBe(true);
      await stub.waitForIdleForTest();

      const stashResult = await stub.getStashResult();
      expect(stashResult).not.toBeNull();
      expect(stashResult!.success).toBe(true);

      const fibers = await stub.getActiveFibers();
      expect(fibers).toHaveLength(0);

      ws.close(1000);
    });

    it("stashed data round-trips through fiber recovery via onChatRecovery", async () => {
      const room = crypto.randomUUID();
      const stub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;

      await stub.setRecoveryOverride({ continue: false });

      await stub.persistMessages([
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        }
      ] as ChatMessage[]);

      const stashedData = {
        responseId: "openai-resp-xyz",
        provider: "openai",
        model: "gpt-4"
      };

      await stub.insertInterruptedStream("stream-stash", "req-stash", [
        {
          body: JSON.stringify({
            type: "start",
            messageId: "assistant-stash"
          }),
          index: 0
        },
        { body: JSON.stringify({ type: "text-start" }), index: 1 },
        {
          body: JSON.stringify({
            type: "text-delta",
            delta: "Partial with stash"
          }),
          index: 2
        }
      ]);
      await stub.insertInterruptedFiber(
        "__cf_internal_chat_turn:req-stash",
        stashedData
      );

      await stub.triggerFiberRecovery();

      const contexts = await stub.getRecoveryContexts();
      expect(contexts.length).toBeGreaterThanOrEqual(1);

      const lastCtx = contexts[contexts.length - 1];
      expect(lastCtx.recoveryData).toEqual(stashedData);
      expect(lastCtx.partialText).toBe("Partial with stash");
      expect(lastCtx.streamId).toBe("stream-stash");
    });
  });

  describe("programmatic turn with unstable_chatRecovery=true", () => {
    it("wraps saveMessages-triggered turn in a fiber and cleans up", async () => {
      const room = crypto.randomUUID();
      const stub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;

      const result = await stub.saveSyntheticUserMessage(
        "Hello from programmatic turn"
      );
      await stub.waitForIdleForTest();

      expect(result.status).toBe("completed");

      const messages = await stub.getPersistedMessages();
      const userMsgs = messages.filter((m) => m.role === "user");
      const assistantMsgs = messages.filter((m) => m.role === "assistant");
      expect(userMsgs).toHaveLength(1);
      expect(assistantMsgs).toHaveLength(1);
      expect(extractAssistantText(messages)).toContain("Continued response.");

      const fibers = await stub.getActiveFibers();
      expect(fibers).toHaveLength(0);

      expect(await stub.getOnChatMessageCallCount()).toBe(1);
    });
  });

  describe("cancellation with unstable_chatRecovery=true", () => {
    it("cleans up fibers and abort controllers when cancelled", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(
        `/agents/recovery-slow-stream-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const collecting = collectMessages(ws);

      sendChatRequest(ws, "req-cancel", [userMessage], {
        format: "sse",
        chunkCount: 100,
        chunkDelayMs: 50,
        useAbortSignal: true
      });

      await new Promise((r) => setTimeout(r, 300));
      sendCancel(ws, "req-cancel");

      const { messages, timedOut } = await collecting;
      expect(timedOut).toBe(false);

      const chatResponses = messages.filter(isUseChatResponseMessage);
      const doneMsg = chatResponses.find((m) => m.done === true);
      expect(doneMsg).toBeDefined();

      const dataChunks = chatResponses.filter(
        (m) => m.body && typeof m.body === "string" && m.body.length > 0
      );
      expect(dataChunks.length).toBeLessThan(100);

      await new Promise((r) => setTimeout(r, 200));

      const stub = (await getAgentByName(
        env.RecoverySlowStreamAgent,
        room
      )) as unknown as SlowStreamStub;

      const fibers = await stub.getActiveFibers();
      expect(fibers).toHaveLength(0);

      const abortCount = await stub.getAbortControllerCount();
      expect(abortCount).toBe(0);

      ws.close(1000);
    });

    it("completes full durable stream without leftover fibers", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(
        `/agents/recovery-slow-stream-agent/${room}`
      );
      await new Promise((r) => setTimeout(r, 50));

      const collecting = collectMessages(ws);

      sendChatRequest(ws, "req-full", [userMessage], {
        format: "sse",
        chunkCount: 3,
        chunkDelayMs: 10
      });

      const { messages, timedOut } = await collecting;
      expect(timedOut).toBe(false);

      const chatResponses = messages.filter(isUseChatResponseMessage);
      expect(chatResponses.find((m) => m.done === true)).toBeDefined();

      await new Promise((r) => setTimeout(r, 100));

      const stub = (await getAgentByName(
        env.RecoverySlowStreamAgent,
        room
      )) as unknown as SlowStreamStub;

      const fibers = await stub.getActiveFibers();
      expect(fibers).toHaveLength(0);

      const abortCount = await stub.getAbortControllerCount();
      expect(abortCount).toBe(0);

      ws.close(1000);
    });
  });
});
