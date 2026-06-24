import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { getAgentByName } from "agents";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS, isUseChatResponseMessage } from "./test-utils";
import { MessageType } from "../types";

interface ChatTestStub {
  getPersistedMessages(): Promise<ChatMessage[]>;
  getActiveFibers(): Promise<Array<{ id: string; name: string }>>;
  getOnChatMessageCallCount(): Promise<number>;
  getRecoveryContexts(): Promise<
    Array<{
      recoveryData: unknown;
      partialText: string;
      streamId: string;
      recoveryRootRequestId: string;
    }>
  >;
  enableExhaustedCaptureForTest(maxAttempts: number): Promise<void>;
  getExhaustedContextsForTest(): Promise<
    Array<{
      recoveryRootRequestId: string;
      terminalMessage: string;
      partialText: string;
      reason: string;
      streamId: string;
      createdAt: number;
    }>
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
  setChatRecoveryConfigForTest(config: {
    maxAttempts?: number;
    terminalMessage?: string;
  }): Promise<void>;
  seedIncidentForTest(incident: {
    incidentId: string;
    requestId: string;
    recoveryKind: "retry" | "continue";
    attempt: number;
    maxAttempts: number;
    status: string;
    firstSeenAt: number;
    lastAttemptAt: number;
  }): Promise<void>;
  getChatRecoveryIncidentsForTest(): Promise<Array<{ status: string }>>;
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

describe("chatRecovery", () => {
  describe("chatRecovery=true via WebSocket", () => {
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

  describe("chatRecovery=false via WebSocket", () => {
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
    it("produces equivalent persisted messages regardless of chatRecovery", async () => {
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

  describe("continueLastTurn with chatRecovery=false", () => {
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

  describe("error handling with chatRecovery=true", () => {
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

  describe("multiple consecutive WS turns with chatRecovery=true", () => {
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

  describe("recovery preserves settled work (#1631)", () => {
    it("persists the settled partial when the recovery budget is exhausted", async () => {
      const room = crypto.randomUUID();
      const stub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;
      // maxAttempts: 1 so a seeded attempt at the cap exhausts on the next wake.
      await stub.setChatRecoveryConfigForTest({ maxAttempts: 1 });

      // text PLUS a settled (completed, non-idempotent) tool call — the work
      // the budget-exhaustion path used to discard and force the model to re-run.
      await stub.insertInterruptedStream("stream-exh", "req-exh", [
        {
          body: JSON.stringify({ type: "start", messageId: "a-exh" }),
          index: 0
        },
        {
          body: JSON.stringify({
            type: "tool-input-available",
            toolCallId: "tc-exh",
            toolName: "writeFile",
            input: { path: "out.txt" }
          }),
          index: 1
        },
        {
          body: JSON.stringify({
            type: "tool-output-available",
            toolCallId: "tc-exh",
            output: { bytesWritten: 12 }
          }),
          index: 2
        },
        { body: JSON.stringify({ type: "text-start" }), index: 3 },
        {
          body: JSON.stringify({ type: "text-delta", delta: "did real work" }),
          index: 4
        }
      ]);
      await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-exh");
      // Seed an incident already at the cap so this recovery exhausts.
      // `lastAttemptAt` is aged past the alarm-debounce window (#1637/#1638) so
      // this wake counts as a genuine new attempt (1 → 2 > maxAttempts) rather
      // than being collapsed as a debounced reconnect (which would hold the
      // attempt at 1 and never exhaust).
      await stub.seedIncidentForTest({
        incidentId: "req-exh:",
        requestId: "req-exh",
        recoveryKind: "continue",
        attempt: 1,
        maxAttempts: 1,
        status: "scheduled",
        firstSeenAt: Date.now() - 60_000,
        lastAttemptAt: Date.now() - 60_000
      });

      await stub.triggerFiberRecovery();

      // Exhaustion seals the turn but must NOT discard the settled partial.
      const messages = await stub.getPersistedMessages();
      const assistantMsgs = messages.filter((m) => m.role === "assistant");
      expect(assistantMsgs).toHaveLength(1);
      expect(extractAssistantText(messages)).toContain("did real work");
      // The settled tool result is preserved (not just the text).
      const settledTool = assistantMsgs[0]?.parts?.find((p) => {
        const part = p as { type?: unknown; output?: unknown; state?: unknown };
        return (
          typeof part.type === "string" &&
          part.type.startsWith("tool-") &&
          (part.output !== undefined || part.state === "output-available")
        );
      });
      expect(settledTool).toBeDefined();

      const incidents = await stub.getChatRecoveryIncidentsForTest();
      expect(incidents[0]?.status).toBe("exhausted");
    });

    it("never drops settled tool results on { persist: false } — preserves them anyway", async () => {
      const room = crypto.randomUUID();
      const stub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;
      await stub.setRecoveryOverride({ persist: false, continue: false });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await stub.insertInterruptedStream("stream-settled", "req-settled", [
          {
            body: JSON.stringify({ type: "start", messageId: "a-settled" }),
            index: 0
          },
          {
            body: JSON.stringify({
              type: "tool-input-available",
              toolCallId: "tc1",
              toolName: "calc",
              input: { x: 1 }
            }),
            index: 1
          },
          {
            body: JSON.stringify({
              type: "tool-output-available",
              toolCallId: "tc1",
              output: { result: 42 }
            }),
            index: 2
          }
        ]);
        await stub.insertInterruptedFiber(
          "__cf_internal_chat_turn:req-settled"
        );

        await stub.triggerFiberRecovery();

        // R1: settled work is preserved regardless of `persist: false` — the
        // assistant partial with the completed tool call IS persisted, with no
        // warning (a safe default beats a warning about an unsafe one).
        const messages = await stub.getPersistedMessages();
        const assistantMsgs = messages.filter((m) => m.role === "assistant");
        expect(assistantMsgs).toHaveLength(1);
        const hasSettledTool = assistantMsgs[0]?.parts?.some((p) => {
          const type = (p as { type?: unknown }).type;
          return typeof type === "string" && type.startsWith("tool-");
        });
        expect(hasSettledTool).toBe(true);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("honors { persist: false } for a text-only partial with no settled work", async () => {
      const room = crypto.randomUUID();
      const stub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;
      await stub.setRecoveryOverride({ persist: false, continue: false });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await stub.insertInterruptedStream("stream-textonly", "req-textonly", [
          {
            body: JSON.stringify({ type: "start", messageId: "a-textonly" }),
            index: 0
          },
          { body: JSON.stringify({ type: "text-start" }), index: 1 },
          {
            body: JSON.stringify({
              type: "text-delta",
              delta: "just prose, no tools"
            }),
            index: 2
          }
        ]);
        await stub.insertInterruptedFiber(
          "__cf_internal_chat_turn:req-textonly"
        );

        await stub.triggerFiberRecovery();

        // No settled tool results to preserve, so `persist: false` is honored —
        // nothing is persisted, and there is no warning.
        const messages = await stub.getPersistedMessages();
        expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("exposes recoveryRootRequestId on the onChatRecovery context", async () => {
      const room = crypto.randomUUID();
      const stub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;

      await stub.insertInterruptedStream("stream-root", "req-root", [
        {
          body: JSON.stringify({ type: "start", messageId: "a-root" }),
          index: 0
        },
        { body: JSON.stringify({ type: "text-start" }), index: 1 },
        {
          body: JSON.stringify({ type: "text-delta", delta: "partial" }),
          index: 2
        }
      ]);
      await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-root");

      await stub.triggerFiberRecovery();

      const contexts = await stub.getRecoveryContexts();
      expect(contexts.length).toBeGreaterThanOrEqual(1);
      expect(contexts[0]?.recoveryRootRequestId).toBe("req-root");
    });

    it("onExhausted context carries terminalMessage, recoveryRootRequestId, and the partial", async () => {
      const room = crypto.randomUUID();
      const stub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;
      await stub.enableExhaustedCaptureForTest(1);

      await stub.insertInterruptedStream("stream-exctx", "req-exctx", [
        {
          body: JSON.stringify({ type: "start", messageId: "a-exctx" }),
          index: 0
        },
        { body: JSON.stringify({ type: "text-start" }), index: 1 },
        {
          body: JSON.stringify({
            type: "text-delta",
            delta: "work before giving up"
          }),
          index: 2
        }
      ]);
      await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-exctx");
      // `lastAttemptAt` aged past the alarm-debounce window (#1637/#1638) so this
      // wake counts as a genuine new attempt (1 → 2 > maxAttempts) and exhausts,
      // rather than being collapsed as a debounced reconnect.
      await stub.seedIncidentForTest({
        incidentId: "req-exctx:",
        requestId: "req-exctx",
        recoveryKind: "continue",
        attempt: 1,
        maxAttempts: 1,
        status: "scheduled",
        firstSeenAt: Date.now() - 60_000,
        lastAttemptAt: Date.now() - 60_000
      });

      await stub.triggerFiberRecovery();

      const exhausted = await stub.getExhaustedContextsForTest();
      expect(exhausted).toHaveLength(1);
      const ctx = exhausted[0];
      expect(ctx.recoveryRootRequestId).toBe("req-exctx");
      expect(ctx.terminalMessage.length).toBeGreaterThan(0);
      expect(ctx.partialText).toContain("work before giving up");
      expect(ctx.reason).toBe("max_attempts_exceeded");
      // streamId + createdAt let a consumer emit correlated terminal telemetry
      // (e.g. msSinceTurnStart) without re-deriving identity (D4).
      expect(ctx.streamId).toBe("stream-exctx");
      expect(typeof ctx.createdAt).toBe("number");
    });
  });

  describe("programmatic turn with chatRecovery=true", () => {
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

  describe("cancellation with chatRecovery=true", () => {
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

  // Reproduction for #1781: a turn interrupted mid-tool-input (the trailing
  // persisted assistant part is a tool call still in `input-streaming` — input
  // never finalized, tool never dispatched). The "continue" strategy has no
  // resumption point for a non-finalized tool call; recovery must instead repair
  // the dead orphan and regenerate, rather than spinning to a stable-timeout.
  describe("recovery from a mid-tool-input interruption (#1781)", () => {
    it("repairs the input-streaming orphan and regenerates instead of exhausting", async () => {
      const room = crypto.randomUUID();
      const stub = (await getAgentByName(
        env.ChatRecoveryTestAgent,
        room
      )) as unknown as ChatTestStub;

      // The interrupted stream ends ON a tool call still in `input-streaming`:
      // `tool-input-start` (+ a partial `tool-input-delta`) with NO
      // `tool-input-available` — the model began emitting a tool-use block but
      // never finished streaming its input, so the call was never finalized or
      // executed.
      await stub.insertInterruptedStream("stream-mid", "req-mid", [
        {
          body: JSON.stringify({ type: "start", messageId: "a-mid" }),
          index: 0
        },
        { body: JSON.stringify({ type: "text-start" }), index: 1 },
        {
          body: JSON.stringify({
            type: "text-delta",
            delta: "Let me write that file"
          }),
          index: 2
        },
        {
          body: JSON.stringify({
            type: "tool-input-start",
            toolCallId: "tc-mid",
            toolName: "writeFile"
          }),
          index: 3
        },
        {
          body: JSON.stringify({
            type: "tool-input-delta",
            toolCallId: "tc-mid",
            inputTextDelta: '{"path":"ou'
          }),
          index: 4
        }
      ]);
      await stub.insertInterruptedFiber("__cf_internal_chat_turn:req-mid");

      await stub.triggerFiberRecovery();
      await stub.waitForIdleForTest();

      // Progress was made: the continuation re-ran inference and produced new
      // tokens (NOT zero-progress → stable-timeout, the #1781 symptom).
      expect(await stub.getOnChatMessageCallCount()).toBe(1);

      const messages = await stub.getPersistedMessages();
      const assistantMsgs = messages.filter((m) => m.role === "assistant");
      expect(assistantMsgs).toHaveLength(1);
      expect(extractAssistantText(messages)).toContain("Continued response.");

      // The non-finalized tool call is no longer dangling in `input-streaming`:
      // it has a settled (errored) result so the next provider call cannot 400.
      const toolPart = assistantMsgs[0]?.parts?.find((p) => {
        const part = p as { type?: unknown; toolCallId?: unknown };
        return (
          typeof part.type === "string" &&
          part.type.startsWith("tool-") &&
          part.toolCallId === "tc-mid"
        );
      }) as { state?: string } | undefined;
      expect(toolPart).toBeDefined();
      expect(toolPart?.state).not.toBe("input-streaming");

      // The turn settled — the incident did not dead-end on a stable-timeout.
      const incidents = await stub.getChatRecoveryIncidentsForTest();
      expect(incidents.every((i) => i.status !== "exhausted")).toBe(true);

      const fibers = await stub.getActiveFibers();
      expect(fibers).toHaveLength(0);
    });
  });
});
