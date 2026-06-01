import { env, exports } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import { subscribe } from "agents/observability";
import type {
  ThinkTestAgent,
  ThinkSessionTestAgent,
  ThinkAsyncConfigSessionAgent,
  ThinkConfigTestAgent,
  ThinkLegacyConfigMigrationAgent,
  ThinkConfigInSessionAgent,
  ThinkProgrammaticTestAgent,
  ThinkAsyncHookTestAgent,
  ThinkRecoveryTestAgent,
  ThinkNonRecoveryTestAgent,
  TestChatResult
} from "./agents/think-session";
import type { ChatResponseResult, SaveMessagesResult } from "../think";

const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";
const MSG_CHAT_CLEAR = "cf_agent_chat_clear";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

async function connectThinkTestAgentWS(room: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `http://example.com/agents/think-test-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

function waitForProtocolMessage(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeout = 3000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for protocol message")),
      timeout
    );
    const handler = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data as string) as Record<
          string,
          unknown
        >;
        if (predicate(message)) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(message);
        }
      } catch {
        // Ignore non-JSON frames.
      }
    };
    ws.addEventListener("message", handler);
  });
}

function closeWS(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.close();
  });
}

async function freshSessionAgent(name: string) {
  return getServerByName(
    env.ThinkSessionTestAgent as unknown as DurableObjectNamespace<ThinkSessionTestAgent>,
    name
  );
}

async function freshAsyncSessionAgent(name: string) {
  return getServerByName(
    env.ThinkAsyncConfigSessionAgent as unknown as DurableObjectNamespace<ThinkAsyncConfigSessionAgent>,
    name
  );
}

async function freshAsyncHookAgent(name: string) {
  return getServerByName(
    env.ThinkAsyncHookTestAgent as unknown as DurableObjectNamespace<ThinkAsyncHookTestAgent>,
    name
  );
}

async function freshProgrammaticAgent(name: string) {
  return getServerByName(
    env.ThinkProgrammaticTestAgent as unknown as DurableObjectNamespace<ThinkProgrammaticTestAgent>,
    name
  );
}

async function freshRecoveryAgent(name: string) {
  return getServerByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

async function freshNonRecoveryAgent(name: string) {
  return getServerByName(
    env.ThinkNonRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkNonRecoveryTestAgent>,
    name
  );
}

async function freshConfigAgent(name: string) {
  return getServerByName(
    env.ThinkConfigTestAgent as unknown as DurableObjectNamespace<ThinkConfigTestAgent>,
    name
  );
}

async function freshConfigInSessionAgent(name: string) {
  return getServerByName(
    env.ThinkConfigInSessionAgent as unknown as DurableObjectNamespace<ThinkConfigInSessionAgent>,
    name
  );
}

async function freshLegacyConfigMigrationAgent(name: string) {
  return getServerByName(
    env.ThinkLegacyConfigMigrationAgent as unknown as DurableObjectNamespace<ThinkLegacyConfigMigrationAgent>,
    name
  );
}

// ── Core chat functionality ──────────────────────────────────────

describe("Think — core", () => {
  it("should run a chat turn and persist messages", async () => {
    const agent = await freshAgent("chat-basic");
    const result = await agent.testChat("Hello!");

    expect(result.done).toBe(true);
    expect(result.events.length).toBeGreaterThan(0);

    const messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(2);
    expect((messages[0] as { role: string }).role).toBe("user");
    expect((messages[1] as { role: string }).role).toBe("assistant");
  });

  it("should broadcast RPC chat message updates to connected clients", async () => {
    const room = "chat-rpc-broadcast";
    const agent = await freshAgent(room);
    const ws = await connectThinkTestAgentWS(room);

    try {
      const userBroadcast = waitForProtocolMessage(ws, (message) => {
        const messages = message.messages as UIMessage[] | undefined;
        return (
          message.type === MSG_CHAT_MESSAGES &&
          Array.isArray(messages) &&
          messages.length === 1 &&
          messages[0].role === "user"
        );
      });
      const assistantBroadcast = waitForProtocolMessage(ws, (message) => {
        const messages = message.messages as UIMessage[] | undefined;
        return (
          message.type === MSG_CHAT_MESSAGES &&
          Array.isArray(messages) &&
          messages.length === 2 &&
          messages[1].role === "assistant"
        );
      });

      await agent.testChat("Hello from RPC");

      await expect(userBroadcast).resolves.toBeTruthy();
      await expect(assistantBroadcast).resolves.toBeTruthy();
    } finally {
      await closeWS(ws);
    }
  });

  it("should broadcast RPC chat stream chunks to connected clients", async () => {
    const room = "chat-rpc-stream-broadcast";
    const agent = await freshAgent(room);
    await agent.setMultiChunkResponse(["first ", "second"]);
    const ws = await connectThinkTestAgentWS(room);

    try {
      const streamChunk = waitForProtocolMessage(ws, (message) => {
        if (
          message.type !== MSG_CHAT_RESPONSE ||
          message.done !== false ||
          typeof message.body !== "string"
        ) {
          return false;
        }
        const chunk = JSON.parse(message.body) as {
          type?: string;
          delta?: unknown;
        };
        return chunk.type === "text-delta" && chunk.delta === "first ";
      });
      const assistantBroadcast = waitForProtocolMessage(ws, (message) => {
        const messages = message.messages as UIMessage[] | undefined;
        return (
          message.type === MSG_CHAT_MESSAGES &&
          Array.isArray(messages) &&
          messages.length === 2 &&
          messages[1].role === "assistant"
        );
      });

      const chat = agent.testChat("Hello from RPC");

      await expect(streamChunk).resolves.toBeTruthy();
      await expect(chat).resolves.toMatchObject({ done: true });
      await expect(assistantBroadcast).resolves.toBeTruthy();
    } finally {
      await closeWS(ws);
    }
  });

  it("should accumulate messages across multiple turns", async () => {
    const agent = await freshAgent("chat-multi");

    await agent.testChat("First message");
    await agent.testChat("Second message");

    const messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(4);
    expect((messages as Array<{ role: string }>).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
  });

  it("should clear all messages", async () => {
    const agent = await freshAgent("chat-clear");

    await agent.testChat("Hello!");
    let messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(2);

    await agent.clearMessages();
    messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(0);
  });

  it("should broadcast programmatic clearMessages to connected clients", async () => {
    const room = "chat-rpc-clear-broadcast";
    const agent = await freshAgent(room);
    await agent.testChat("Hello before clear");
    const ws = await connectThinkTestAgentWS(room);

    try {
      const clearBroadcast = waitForProtocolMessage(
        ws,
        (message) => message.type === MSG_CHAT_CLEAR
      );

      await agent.clearMessages();

      await expect(clearBroadcast).resolves.toBeTruthy();
    } finally {
      await closeWS(ws);
    }
  });

  it("should stream events via callback", async () => {
    const agent = await freshAgent("chat-stream");
    const result = await agent.testChat("Tell me something");

    expect(result.done).toBe(true);
    expect(result.events.length).toBeGreaterThan(0);

    const eventTypes = (result.events as string[]).map((e) => {
      const parsed = JSON.parse(e) as { type: string };
      return parsed.type;
    });

    expect(eventTypes).toContain("text-delta");
  });

  it("should return empty messages before first chat", async () => {
    const agent = await freshAgent("chat-empty");

    const messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(0);
  });

  it("should use custom response from setResponse", async () => {
    const agent = await freshAgent("chat-custom-response");

    await agent.setResponse("Custom response text");
    const result = await agent.testChat("Say something");

    expect(result.done).toBe(true);

    const messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(2);
    const assistantMsg = messages[1] as {
      role: string;
      parts: Array<{ type: string; text?: string }>;
    };
    expect(assistantMsg.role).toBe("assistant");
    const textParts = assistantMsg.parts.filter((p) => p.type === "text");
    const fullText = textParts.map((p) => p.text ?? "").join("");
    expect(fullText).toBe("Custom response text");
  });

  it("should ignore runtime tools passed to chat()", async () => {
    const agent = await freshAgent("chat-ignore-runtime-tools");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await agent.testChatWithIgnoredRuntimeTools("Hello");
      expect(result.done).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("chat() no longer accepts options.tools")
      );
    } finally {
      warn.mockRestore();
    }

    const turnLog = await agent.getBeforeTurnLog();
    expect(turnLog).toHaveLength(1);
    expect(turnLog[0].toolNames).not.toContain("ignoredRuntimeTool");
  });

  it("should forward turn telemetry to the AI SDK", async () => {
    const agent = await freshAgent("chat-telemetry");

    await agent.setTurnConfigTelemetry();
    const result = await agent.testChat("Trace this turn");

    expect(result.done).toBe(true);
    await expect(agent.getTelemetryEvents()).resolves.toEqual([
      "start:think-test-turn:think-test",
      "finish:think-test-turn:think-test"
    ]);
  });

  it("should build assistant message with text parts", async () => {
    const agent = await freshAgent("chat-parts");
    await agent.testChat("Hello!");

    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(2);

    const assistantMsg = history[1] as {
      role: string;
      parts: Array<{ type: string; text?: string }>;
    };
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.parts.length).toBeGreaterThan(0);

    const textParts = assistantMsg.parts.filter((p) => p.type === "text");
    expect(textParts.length).toBeGreaterThan(0);
    expect(textParts[0].text).toBeTruthy();
  });
});

// ── Error handling + partial persistence ─────────────────────────

describe("Think — error handling", () => {
  it("should handle errors and return error message", async () => {
    const agent = await freshAgent("err-basic");

    const result = await agent.testChatWithError("LLM exploded");

    expect(result.done).toBe(false);
    expect(result.error).toContain("LLM exploded");
  });

  it("should persist partial assistant message on error", async () => {
    const agent = await freshAgent("err-partial");

    await agent.setResponse("This is a partial response");
    const result = await agent.testChatWithError("Mid-stream failure");

    expect(result.done).toBe(false);
    expect(result.events.length).toBeGreaterThan(0);

    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(2);

    const assistantMsg = history[1] as {
      role: string;
      parts: Array<{ type: string }>;
    };
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.parts.length).toBeGreaterThan(0);
  });

  it("should log errors via onChatError hook", async () => {
    const agent = await freshAgent("err-hook");

    await agent.testChatWithError("Custom error for hook");

    const errorLog = await agent.getChatErrorLog();
    expect(errorLog).toHaveLength(1);
    expect(errorLog[0]).toContain("Custom error for hook");
  });

  it("emits chat:request:failed when a chat stream fails", async () => {
    const agent = await freshAgent(`err-event-${crypto.randomUUID()}`);
    const events: Array<{
      type: string;
      payload: {
        requestId?: string;
        stage?: string;
        messagesPersisted?: boolean;
        error?: string;
      };
    }> = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:request:failed") {
        events.push(event);
      }
    });

    try {
      await agent.testChatWithError("Custom event error");
    } finally {
      unsubscribe();
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "chat:request:failed",
        payload: expect.objectContaining({
          stage: "stream",
          messagesPersisted: true,
          error: "Custom event error"
        })
      })
    );
  });

  it("aborts a stalled stream via the inactivity watchdog instead of hanging forever", async () => {
    const agent = await freshAgent(`stall-${crypto.randomUUID()}`);
    const stalled: Array<{ requestId?: string; timeoutMs?: number }> = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:stream:stalled") {
        stalled.push(
          event.payload as { requestId?: string; timeoutMs?: number }
        );
      }
    });

    let result: TestChatResult;
    try {
      // Emit one chunk, then hang forever. Without the watchdog this turn never
      // resolves (the read loop parks on a promise that never settles); the test
      // would hit the vitest timeout. With it, the turn ends terminally.
      result = await agent.testChatWithStall(1, 50);
    } finally {
      unsubscribe();
    }

    expect(result.done).toBe(false);
    expect(result.error).toContain("stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.timeoutMs).toBe(50);
  });

  it("does not fire the watchdog for a slow-but-steady stream (timer resets per chunk)", async () => {
    const agent = await freshAgent(`slow-${crypto.randomUUID()}`);
    const stalled: Array<unknown> = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:stream:stalled") stalled.push(event.payload);
    });

    let result: TestChatResult;
    try {
      // Each chunk arrives at ~15ms; watchdog window is 200ms. The gap never
      // exceeds the window, so the turn must complete normally.
      result = await agent.testChatWithSlowStream(15, 200);
    } finally {
      unsubscribe();
    }

    expect(result.done).toBe(true);
    expect(result.error).toBeUndefined();
    expect(stalled).toHaveLength(0);
  });

  it("terminates cleanly on an in-band stream error while the watchdog is armed", async () => {
    const agent = await freshAgent(`err-guard-${crypto.randomUUID()}`);
    // An in-band error breaks the read loop without aborting the signal. With
    // the watchdog wrapper active, the source must still be cancelled on break
    // (no unhandled rejection — vitest would surface one as a test error).
    const result = await agent.testChatWithErrorUnderStallGuard(5000);

    expect(result.done).toBe(false);
    expect(result.error).toContain("Mock error under guard");
  });

  it("routes a stream-stall watchdog abort into bounded recovery instead of failing terminally (#1626)", async () => {
    const agent = await freshAgent(`stall-recover-${crypto.randomUUID()}`);
    // The first inference hangs after 1 chunk → the watchdog aborts it. Instead
    // of a terminal error, the turn is routed into bounded recovery; the
    // scheduled continuation streams normally to completion.
    // Stall after 3 UI chunks (past the first text-delta) so the partial has
    // settled content to re-anchor the continuation.
    const result = await agent.testChatWithStallThenRecover(3, 50);

    // The stall did NOT terminalize — no terminal error surfaced...
    expect(result.firstError).toBeUndefined();
    // ...a continuation was scheduled...
    expect(result.scheduledContinues).toBeGreaterThanOrEqual(1);
    // ...and it streamed the turn to completion (recovered, not failed).
    expect(result.finalAssistantText.length).toBeGreaterThan(0);
  });

  it("honors a per-turn TurnConfig.chatStreamStallTimeoutMs override even when the instance watchdog is off (#1626)", async () => {
    const agent = await freshAgent(`stall-perturn-${crypto.randomUUID()}`);
    // Instance watchdog is OFF; only the per-turn override (from beforeTurn)
    // arms it. The stall must still fire + route into bounded recovery.
    const result = await agent.testChatWithPerTurnStallOverride(50);

    expect(result.firstError).toBeUndefined();
    expect(result.scheduledContinues).toBeGreaterThanOrEqual(1);
    expect(result.finalAssistantText.length).toBeGreaterThan(0);
  });

  it("should recover and continue chatting after error", async () => {
    const agent = await freshAgent("err-recover");

    const errResult = await agent.testChatWithError("Temporary failure");
    expect(errResult.done).toBe(false);

    const okResult = await agent.testChat("After error");
    expect(okResult.done).toBe(true);

    const stored = (await agent.getStoredMessages()) as UIMessage[];
    expect(stored).toHaveLength(4);
  });
});

// ── Abort/cancel ─────────────────────────────────────────────────

describe("Think — abort", () => {
  it("should stop streaming on abort and not call onDone", async () => {
    const agent = await freshAgent("abort-basic");

    await agent.setMultiChunkResponse([
      "chunk1 ",
      "chunk2 ",
      "chunk3 ",
      "chunk4 ",
      "chunk5 "
    ]);

    const result = await agent.testChatWithAbort("Abort me", 2);

    expect(result.doneCalled).toBe(false);
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    expect(result.events.length).toBeLessThan(10);
  });

  it("should expose chat request ids for cross-RPC cancellation", async () => {
    const agent = await freshAgent("abort-cancel-chat");

    await agent.setMultiChunkResponse([
      "chunk1 ",
      "chunk2 ",
      "chunk3 ",
      "chunk4 ",
      "chunk5 "
    ]);

    const result = await agent.testChatWithCancelChat("Cancel me", 2);

    expect(result.requestId).toBeTruthy();
    expect(result.doneCalled).toBe(false);
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    expect(result.events.length).toBeLessThan(10);
  });

  it("should persist partial message on abort", async () => {
    const agent = await freshAgent("abort-persist");

    await agent.setMultiChunkResponse([
      "partial1 ",
      "partial2 ",
      "partial3 ",
      "partial4 "
    ]);

    await agent.testChatWithAbort("Abort and persist", 2);

    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(2);

    const assistantMsg = history[1] as {
      role: string;
      parts: Array<{ type: string }>;
    };
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.parts.length).toBeGreaterThan(0);
  });

  it("should recover and chat normally after abort", async () => {
    const agent = await freshAgent("abort-recover");

    await agent.setMultiChunkResponse(["a ", "b ", "c ", "d "]);
    await agent.testChatWithAbort("Abort this", 2);

    await agent.clearMultiChunkResponse();
    const result = await agent.testChat("Normal after abort");
    expect(result.done).toBe(true);

    const stored = (await agent.getStoredMessages()) as UIMessage[];
    expect(stored).toHaveLength(4);
  });
});

// ── Richer input (UIMessage) ─────────────────────────────────────

describe("Think — richer input", () => {
  it("should accept UIMessage as input", async () => {
    const agent = await freshAgent("rich-uimsg");

    const userMsg: UIMessage = {
      id: "custom-id-123",
      role: "user",
      parts: [{ type: "text", text: "Hello via UIMessage" }]
    };

    const result = await agent.testChatWithUIMessage(userMsg);
    expect(result.done).toBe(true);

    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(2);

    const firstMsg = history[0] as { id: string; role: string };
    expect(firstMsg.id).toBe("custom-id-123");
    expect(firstMsg.role).toBe("user");
  });

  it("should handle UIMessage with multiple parts", async () => {
    const agent = await freshAgent("rich-multipart");

    const userMsg: UIMessage = {
      id: "multipart-1",
      role: "user",
      parts: [
        { type: "text", text: "First part" },
        { type: "text", text: "Second part" }
      ]
    };

    const result = await agent.testChatWithUIMessage(userMsg);
    expect(result.done).toBe(true);

    const history = await agent.getStoredMessages();
    const firstMsg = history[0] as {
      parts: Array<{ type: string; text?: string }>;
    };
    expect(firstMsg.parts).toHaveLength(2);
  });
});

// ── Session integration ──────────────────────────────────────────

describe("Think — Session integration", () => {
  it("should use tree-structured messages via Session", async () => {
    const agent = await freshAgent("session-tree");

    await agent.testChat("First");
    await agent.testChat("Second");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
  });

  it("should idempotently handle duplicate user messages", async () => {
    const agent = await freshAgent("session-idempotent");

    const msg: UIMessage = {
      id: "dup-msg-1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    await agent.testChatWithUIMessage(msg);

    // Second chat with the same message ID should not duplicate
    const result = await agent.testChat("Follow up");
    expect(result.done).toBe(true);

    const messages = await agent.getStoredMessages();
    // Should have: dup-msg-1 (user) + assistant + user + assistant = 4
    expect(messages).toHaveLength(4);
  });

  it("keeps cache aligned when storage ignores a duplicate message id", async () => {
    const agent = await freshAgent("session-duplicate-cache");
    const msg: UIMessage = {
      id: "dup-cache-1",
      role: "user",
      parts: [{ type: "text", text: "Original content" }]
    };

    await agent.testChatWithUIMessage(msg);
    await agent.testChatWithUIMessage({
      ...msg,
      parts: [{ type: "text", text: "Rejected duplicate content" }]
    });

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const text = JSON.stringify(messages);
    expect(text).toContain("Original content");
    expect(text).not.toContain("Rejected duplicate content");
  });

  it("refreshes cached messages when an append triggers compaction", async () => {
    const agent = await freshAgent("session-compaction-cache");
    await agent.enableCompactionForTest();

    const result = await agent.testChat("Trigger compaction");

    expect(result.done).toBe(true);
    const publicMessages = (await agent.getStoredMessages()) as UIMessage[];
    const storageMessages =
      (await agent.getSessionHistoryForTest()) as UIMessage[];
    expect(publicMessages.map((m) => ({ id: m.id, parts: m.parts }))).toEqual(
      storageMessages.map((m) => ({ id: m.id, parts: m.parts }))
    );
    expect(JSON.stringify(publicMessages)).toContain("compacted-summary");
  });

  it("returns a copy from getMessages", async () => {
    const agent = await freshAgent("session-get-messages-copy");
    await agent.testChat("Hello!");

    expect(await agent.mutatingGetMessagesResultChangesCacheForTest()).toBe(
      false
    );
  });

  it("provides a cache-aware append helper for subclasses", async () => {
    const agent = await freshAgent("session-history-helper");
    await agent.appendHistoryMessageForTest({
      id: "history-helper-user",
      role: "user",
      parts: [{ type: "text", text: "Via helper" }]
    });

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("history-helper-user");
  });

  it("keeps cache aligned for direct session appendMessage calls", async () => {
    const agent = await freshAgent("session-direct-append");
    await agent.appendSessionMessageForTest({
      id: "direct-session-user",
      role: "user",
      parts: [{ type: "text", text: "Direct session append" }]
    });

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("direct-session-user");
  });

  it("does not append missing messages to cache on direct session updateMessage calls", async () => {
    const agent = await freshAgent("session-direct-update-missing");
    await agent.appendSessionMessageForTest({
      id: "cached-user",
      role: "user",
      parts: [{ type: "text", text: "Cached message" }]
    });

    await agent.updateSessionMessageForTest({
      id: "missing-from-cache",
      role: "user",
      parts: [{ type: "text", text: "Should not enter model context" }]
    });

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("cached-user");
    expect(JSON.stringify(messages)).not.toContain("Should not enter");
  });

  it("should clear messages via Session", async () => {
    const agent = await freshAgent("session-clear");

    await agent.testChat("Hello!");
    expect(((await agent.getStoredMessages()) as UIMessage[]).length).toBe(2);

    await agent.clearMessages();
    expect(((await agent.getStoredMessages()) as UIMessage[]).length).toBe(0);

    // Should be able to chat after clear
    const result = await agent.testChat("After clear");
    expect(result.done).toBe(true);
    expect(((await agent.getStoredMessages()) as UIMessage[]).length).toBe(2);
  });
});

// ── Context blocks ───────────────────────────────────────────────

describe("Think — context blocks", () => {
  it("should configure session with context blocks", async () => {
    const agent = await freshSessionAgent("ctx-basic");

    await agent.testChat("Hello!");

    const messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(2);
  });

  it("should freeze system prompt from context blocks", async () => {
    const agent = await freshSessionAgent("ctx-prompt");

    // Write some content to the memory block
    await agent.setContextBlock("memory", "User prefers TypeScript.");

    const prompt = await agent.getSystemPromptSnapshot();

    // Prompt should contain the block content
    expect(prompt).toContain("MEMORY");
    expect(prompt).toContain("User prefers TypeScript.");
  });

  it("should persist context block content across turns", async () => {
    const agent = await freshSessionAgent("ctx-persist");

    await agent.setContextBlock("memory", "Fact 1: User likes cats.");
    await agent.testChat("Hello!");

    const content = await agent.getContextBlockContent("memory");
    expect(content).toBe("Fact 1: User likes cats.");
  });

  it("should use context blocks in system prompt assembly even when called directly", async () => {
    const agent = await freshSessionAgent("ctx-assemble-direct");

    await agent.setContextBlock("memory", "User prefers Rust over Go.");

    // Call getAssembledSystemPrompt directly — without session.tools() being called first.
    // This verifies that freezeSystemPrompt triggers context block loading on its own.
    const systemPrompt = await agent.getAssembledSystemPrompt();

    expect(systemPrompt).toContain("MEMORY");
    expect(systemPrompt).toContain("User prefers Rust over Go.");
  });

  it("should render empty writable blocks in system prompt", async () => {
    const agent = await freshSessionAgent("ctx-fallback");

    // Writable blocks render even when empty so the LLM knows they exist
    const systemPrompt = await agent.getAssembledSystemPrompt();

    expect(systemPrompt).toContain("MEMORY");
    expect(systemPrompt).toContain("[writable]");
  });
});

// ── Async configureSession ───────────────────────────────────────

describe("Think — async configureSession", () => {
  it("should initialize and chat with async configureSession", async () => {
    const agent = await freshAsyncSessionAgent("async-cfg-basic");

    const result = await agent.testChat("Hello async!");
    expect(result.done).toBe(true);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("should have working context blocks from async config", async () => {
    const agent = await freshAsyncSessionAgent("async-cfg-ctx");

    await agent.setContextBlock("memory", "Async-configured fact.");

    const prompt = (await agent.getAssembledSystemPrompt()) as string;
    expect(prompt).toContain("MEMORY");
    expect(prompt).toContain("Async-configured fact.");
  });

  it("should support multiple turns after async init", async () => {
    const agent = await freshAsyncSessionAgent("async-cfg-multi");

    await agent.testChat("Turn 1");
    await agent.testChat("Turn 2");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);
  });
});

// ── Dynamic configuration ────────────────────────────────────────

describe("Think — dynamic configuration", () => {
  it("should persist and retrieve typed configuration", async () => {
    const agent = await freshConfigAgent("config-basic");

    await agent.setTestConfig({ theme: "dark", maxTokens: 4000 });
    const config = await agent.getTestConfig();

    expect(config).not.toBeNull();
    expect(config!.theme).toBe("dark");
    expect(config!.maxTokens).toBe(4000);
  });

  it("should return null for unconfigured agent", async () => {
    const agent = await freshConfigAgent("config-empty");

    const config = await agent.getTestConfig();
    expect(config).toBeNull();
  });

  it("should overwrite configuration on re-configure", async () => {
    const agent = await freshConfigAgent("config-overwrite");

    await agent.setTestConfig({ theme: "light", maxTokens: 2000 });
    await agent.setTestConfig({ theme: "dark", maxTokens: 8000 });

    const config = await agent.getTestConfig();
    expect(config!.theme).toBe("dark");
    expect(config!.maxTokens).toBe(8000);
  });

  it("should migrate legacy Think config out of assistant_config", async () => {
    const agent = await freshLegacyConfigMigrationAgent(
      "config-legacy-migration"
    );

    const config = await agent.getTestConfig();
    expect(config).not.toBeNull();
    expect(config!.theme).toBe("dark");
    expect(config!.maxTokens).toBe(4000);
  });

  it("should not let legacy config overwrite newer think_config values on rerun", async () => {
    const agent = await freshLegacyConfigMigrationAgent(
      "config-legacy-rerun-preserves-newer"
    );

    await agent.setTestConfig({ theme: "light", maxTokens: 2000 });
    await agent.rerunLegacyMigrationForTest();

    const config = await agent.getRawThinkConfigForTest();
    expect(config).not.toBeNull();
    expect(config!.theme).toBe("light");
    expect(config!.maxTokens).toBe(2000);
  });
});

// ── getConfig() inside configureSession (GH-1309) ───────────────

describe("Think — getConfig inside configureSession", () => {
  it("should not throw when getConfig() is called in configureSession on first start", async () => {
    const agent = await freshConfigInSessionAgent("cfg-in-session-first");

    const result = await agent.testChat("Hello!");
    expect(result.done).toBe(true);

    const messages = await agent.getStoredMessages();
    expect(messages).toHaveLength(2);
  });

  it("should read previously stored config inside configureSession", async () => {
    const agent = await freshConfigInSessionAgent("cfg-in-session-read");

    await agent.setTestConfig({ persona: "pirate" });

    const config = await agent.getTestConfig();
    expect(config).not.toBeNull();
    expect(config!.persona).toBe("pirate");

    const result = await agent.testChat("Ahoy!");
    expect(result.done).toBe(true);
  });

  it("should fall back to default when no config is stored", async () => {
    const agent = await freshConfigInSessionAgent("cfg-in-session-default");

    const config = await agent.getTestConfig();
    expect(config).toBeNull();

    const result = await agent.testChat("Hello!");
    expect(result.done).toBe(true);
  });
});

// ── onChatResponse hook ──────────────────────────────────────────

describe("Think — onChatResponse", () => {
  it("should fire onChatResponse after successful chat turn", async () => {
    const agent = await freshAgent("hook-success");

    await agent.testChat("Hello!");

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("completed");
    expect(log[0].continuation).toBe(false);
    expect(log[0].message.role).toBe("assistant");
    expect(log[0].requestId).toBeTruthy();
  });

  it("should fire onChatResponse for empty successful streams", async () => {
    const agent = await freshAgent("hook-empty-stream");

    await agent.runEmptyStreamForTest();

    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(0);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("completed");
    expect(log[0].message.role).toBe("assistant");
    expect(log[0].message.parts).toHaveLength(0);
  });

  it("should fire onChatResponse and onDone for empty successful RPC streams", async () => {
    const agent = await freshAgent("hook-empty-rpc-stream");

    const result = await agent.runEmptyRpcStreamForTest();

    expect(result.doneCalled).toBe(true);
    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(0);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("completed");
    expect(log[0].message.role).toBe("assistant");
    expect(log[0].message.parts).toHaveLength(0);
  });

  it("should fire onChatResponse with error status on failure", async () => {
    const agent = await freshAgent("hook-error");

    await agent.testChatWithError("Boom");

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("error");
    expect(log[0].error).toContain("Boom");
  });

  it("should fire onChatResponse with error status when in-band error arrives before any parts", async () => {
    const room = "hook-inband-error";
    const observedTypes: string[] = [];
    const unsubscribe = subscribe("message", (event) => {
      if (event.agent === "ThinkTestAgent" && event.name === room) {
        observedTypes.push(event.type);
      }
    });
    const agent = await freshAgent(room);

    try {
      await agent.runInBandStreamErrorForTest("Early in-band error");

      const log = (await agent.getResponseLog()) as ChatResponseResult[];
      expect(log).toHaveLength(1);
      expect(log[0].status).toBe("error");
      expect(log[0].error).toContain("Early in-band error");
      expect(observedTypes).toContain("message:error");
      await expect(agent.getLatestStreamStatusForTest()).resolves.toBe("error");
    } finally {
      unsubscribe();
    }
  });

  it("should persist partial parts and fire error status for in-band errors", async () => {
    const agent = await freshAgent("hook-partial-inband-error");

    await agent.runPartialInBandStreamErrorForTest("Late in-band error");

    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(1);
    const assistantMsg = history[0] as {
      role: string;
      parts: Array<{ type: string; text?: string }>;
    };
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.parts[0]).toMatchObject({
      type: "text",
      text: "partial response"
    });

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("error");
    expect(log[0].error).toContain("Late in-band error");
    await expect(agent.getLatestStreamStatusForTest()).resolves.toBe("error");
  });

  it("should treat in-band errors as terminal stream events", async () => {
    const agent = await freshAgent("hook-terminal-inband-error");

    await agent.runInBandStreamErrorThenTextForTest("Terminal in-band error");

    const history = await agent.getStoredMessages();
    expect(history).toHaveLength(0);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("error");
    expect(log[0].error).toContain("Terminal in-band error");
  });

  it("should report in-band stream errors through RPC chat onError", async () => {
    const room = "hook-rpc-inband-error";
    const observedTypes: string[] = [];
    const unsubscribe = subscribe("message", (event) => {
      if (event.agent === "ThinkTestAgent" && event.name === room) {
        observedTypes.push(event.type);
      }
    });
    const agent = await freshAgent(room);

    try {
      await agent.setInBandErrorResponse("RPC in-band error");
      const result = await agent.testChat("trigger rpc in-band error");

      expect(result.done).toBe(false);
      expect(result.error).toContain("RPC in-band error");

      const log = (await agent.getResponseLog()) as ChatResponseResult[];
      expect(log).toHaveLength(1);
      expect(log[0].status).toBe("error");
      expect(log[0].error).toContain("RPC in-band error");
      expect(observedTypes).toContain("message:error");
      await expect(agent.getLatestStreamStatusForTest()).resolves.toBe("error");
    } finally {
      unsubscribe();
    }
  });

  it("should propagate RPC in-band stream errors when onError rethrows", async () => {
    const agent = await freshAgent("hook-rpc-inband-error-rethrow");

    await agent.setInBandErrorResponse("RPC missing callback error");
    const error = await agent.testChatWithRethrowingErrorCallback(
      "trigger rpc in-band error"
    );

    expect(error).toContain("RPC missing callback error");

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("error");
    expect(log[0].error).toContain("RPC missing callback error");
  });

  it("should not fire duplicate response hooks when RPC onError throws", async () => {
    const agent = await freshAgent("hook-rpc-inband-error-callback-throws");

    await agent.setInBandErrorResponse("RPC callback throws source error");
    const error = await agent.testChatWithThrowingErrorCallback(
      "trigger rpc in-band error"
    );

    expect(error).toBe("callback failed");

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("error");
    expect(log[0].error).toContain("RPC callback throws source error");
  });

  it("should fire onChatResponse with aborted status on abort", async () => {
    const agent = await freshAgent("hook-abort");

    await agent.setMultiChunkResponse([
      "chunk1 ",
      "chunk2 ",
      "chunk3 ",
      "chunk4 "
    ]);
    await agent.testChatWithAbort("Abort me", 2);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("aborted");
  });

  it("should accumulate response hooks across multiple turns", async () => {
    const agent = await freshAgent("hook-multi");

    await agent.testChat("Turn 1");
    await agent.testChat("Turn 2");

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(2);
    expect(log[0].status).toBe("completed");
    expect(log[1].status).toBe("completed");
  });
});

// ── Message sanitization ─────────────────────────────────────────

describe("Think — sanitization", () => {
  it("should strip OpenAI ephemeral itemId from providerMetadata", async () => {
    const agent = await freshAgent("sanitize-openai");

    const msg: UIMessage = {
      id: "test-1",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Hello",
          providerMetadata: {
            openai: { itemId: "item_abc123", otherField: "keep" }
          }
        } as UIMessage["parts"][number]
      ]
    };

    const sanitized = (await agent.sanitizeMessage(msg)) as UIMessage;
    const part = sanitized.parts[0] as Record<string, unknown>;
    const meta = part.providerMetadata as Record<string, unknown> | undefined;

    expect(meta).toBeDefined();
    expect(meta!.openai).toBeDefined();
    const openaiMeta = meta!.openai as Record<string, unknown>;
    expect(openaiMeta.itemId).toBeUndefined();
    expect(openaiMeta.otherField).toBe("keep");
  });

  it("should strip reasoningEncryptedContent from OpenAI metadata", async () => {
    const agent = await freshAgent("sanitize-reasoning-enc");

    const msg: UIMessage = {
      id: "test-2",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Hello",
          providerMetadata: {
            openai: { reasoningEncryptedContent: "encrypted_data" }
          }
        } as UIMessage["parts"][number]
      ]
    };

    const sanitized = (await agent.sanitizeMessage(msg)) as UIMessage;
    const part = sanitized.parts[0] as Record<string, unknown>;

    expect(part.providerMetadata).toBeUndefined();
  });

  it("should filter empty reasoning parts without providerMetadata", async () => {
    const agent = await freshAgent("sanitize-empty-reasoning");

    const msg: UIMessage = {
      id: "test-3",
      role: "assistant",
      parts: [
        { type: "text", text: "Hello" },
        { type: "reasoning", text: "" } as UIMessage["parts"][number],
        { type: "reasoning", text: "Thinking..." } as UIMessage["parts"][number]
      ]
    };

    const sanitized = (await agent.sanitizeMessage(msg)) as UIMessage;

    expect(sanitized.parts).toHaveLength(2);
    expect(sanitized.parts[0].type).toBe("text");
    expect(sanitized.parts[1].type).toBe("reasoning");
  });

  it("should preserve reasoning parts with providerMetadata", async () => {
    const agent = await freshAgent("sanitize-keep-reasoning-meta");

    const msg: UIMessage = {
      id: "test-4",
      role: "assistant",
      parts: [
        { type: "text", text: "Hello" },
        {
          type: "reasoning",
          text: "",
          providerMetadata: {
            anthropic: { redactedData: "abc" }
          }
        } as UIMessage["parts"][number]
      ]
    };

    const sanitized = (await agent.sanitizeMessage(msg)) as UIMessage;

    expect(sanitized.parts).toHaveLength(2);
  });

  it("should pass through messages without OpenAI metadata unchanged", async () => {
    const agent = await freshAgent("sanitize-noop");

    const msg: UIMessage = {
      id: "test-5",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    };

    const sanitized = (await agent.sanitizeMessage(msg)) as UIMessage;
    expect(sanitized.parts).toHaveLength(1);
    expect((sanitized.parts[0] as { text: string }).text).toBe("Hello");
  });
});

// ── Row size enforcement ─────────────────────────────────────────

describe("Think — row size enforcement", () => {
  it("should pass through small messages unchanged", async () => {
    const agent = await freshAgent("rowsize-small");

    const msg: UIMessage = {
      id: "small-1",
      role: "assistant",
      parts: [{ type: "text", text: "Short message" }]
    };

    const result = (await agent.enforceRowSizeLimit(msg)) as UIMessage;
    expect((result.parts[0] as { text: string }).text).toBe("Short message");
  });

  it("should compact large tool outputs", async () => {
    const agent = await freshAgent("rowsize-tool");

    const hugeOutput = "x".repeat(2_000_000);
    const msg: UIMessage = {
      id: "tool-big",
      role: "assistant",
      parts: [
        {
          type: "tool-read_file",
          toolCallId: "tc-1",
          toolName: "read_file",
          state: "output-available",
          input: {},
          output: hugeOutput
        } as UIMessage["parts"][number]
      ]
    };

    const result = (await agent.enforceRowSizeLimit(msg)) as UIMessage;
    const toolPart = result.parts[0] as Record<string, unknown>;
    const output = toolPart.output as string;

    expect(output).toContain("[truncated");
    expect(output.length).toBeLessThan(hugeOutput.length);
  });

  it("should truncate large text parts for non-assistant messages", async () => {
    const agent = await freshAgent("rowsize-user-text");

    const hugeText = "y".repeat(2_000_000);
    const msg: UIMessage = {
      id: "user-big",
      role: "user",
      parts: [{ type: "text", text: hugeText }]
    };

    const result = (await agent.enforceRowSizeLimit(msg)) as UIMessage;
    const textPart = result.parts[0] as { text: string };

    expect(textPart.text).toContain("Text truncated");
    expect(textPart.text.length).toBeLessThan(hugeText.length);
  });
});

// ── Model message conversion ─────────────────────────────────────

describe("Think — model message conversion", () => {
  it("replays truncated workspace text read outputs as text", async () => {
    const agent = await freshAgent("model-conversion-truncated-read");
    const largeContent = "read-output ".repeat(100);

    await agent.persistTestMessage({
      id: "u-read-text",
      role: "user",
      parts: [{ type: "text", text: "Read /large.txt" }]
    });
    await agent.persistTestMessage({
      id: "a-read-text",
      role: "assistant",
      parts: [
        {
          type: "tool-read",
          toolCallId: "tc-read-text",
          state: "output-available",
          input: { path: "/large.txt" },
          output: {
            path: "/large.txt",
            content: largeContent,
            totalLines: 1
          }
        } as UIMessage["parts"][number]
      ]
    });
    for (let i = 0; i < 4; i++) {
      await agent.persistTestMessage({
        id: `recent-${i}`,
        role: "user",
        parts: [{ type: "text", text: `recent ${i}` }]
      });
    }

    const result = await agent.testChat("follow up");

    expect(result.error).toBeUndefined();
    const messagesJson = await agent.getLastBeforeTurnMessagesJson();
    expect(messagesJson).not.toBeNull();
    const messages = JSON.parse(messagesJson!) as Array<{
      role: string;
      content?: Array<{
        output?: {
          type: string;
          value?: string;
        };
      }>;
    }>;
    const toolOutput = messages
      .find((message) => message.role === "tool")
      ?.content?.find((part) => part.output?.type === "text")?.output;

    expect(toolOutput?.value).toContain("[truncated");
    expect(toolOutput?.value).toContain("read-output");
  });

  it("replays legacy raw-string workspace read outputs as text", async () => {
    const agent = await freshAgent("model-conversion-string-read");
    const legacyOutput =
      "This read output was truncated by an older SDK version.";

    await agent.persistTestMessage({
      id: "u-read-legacy",
      role: "user",
      parts: [{ type: "text", text: "Read /legacy.txt" }]
    });
    await agent.persistTestMessage({
      id: "a-read-legacy",
      role: "assistant",
      parts: [
        {
          type: "tool-read",
          toolCallId: "tc-read-legacy",
          state: "output-available",
          input: { path: "/legacy.txt" },
          output: legacyOutput
        } as UIMessage["parts"][number]
      ]
    });

    const result = await agent.testChat("follow up");

    expect(result.error).toBeUndefined();
    const messagesJson = await agent.getLastBeforeTurnMessagesJson();
    expect(messagesJson).not.toBeNull();
    const messages = JSON.parse(messagesJson!) as Array<{
      role: string;
      content?: Array<{
        output?: {
          type: string;
          value?: string;
        };
      }>;
    }>;
    const toolOutput = messages
      .find((message) => message.role === "tool")
      ?.content?.find((part) => part.output?.type === "text")?.output;

    expect(toolOutput?.value).toBe(legacyOutput);
  });

  it("rehydrates compact workspace image read outputs during replay", async () => {
    const agent = await freshAgent("model-conversion-image-read");
    const imageBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    await agent.seedWorkspaceBytes("/screenshot", imageBytes, "image/png");

    await agent.persistTestMessage({
      id: "u-read-image",
      role: "user",
      parts: [{ type: "text", text: "Read /screenshot" }]
    });
    await agent.persistTestMessage({
      id: "a-read-image",
      role: "assistant",
      parts: [
        {
          type: "tool-read",
          toolCallId: "tc-read-image",
          state: "output-available",
          input: { path: "/screenshot" },
          output: {
            kind: "image",
            path: "/screenshot",
            name: "screenshot",
            mediaType: "image/png",
            sizeBytes: imageBytes.length
          }
        } as UIMessage["parts"][number]
      ]
    });

    await agent.testChat("What is in the screenshot?");

    const messagesJson = await agent.getLastBeforeTurnMessagesJson();
    expect(messagesJson).not.toBeNull();
    const messages = JSON.parse(messagesJson!) as Array<{
      role: string;
      content?: Array<{
        output?: {
          type: string;
          value?: Array<{ type: string; data?: string; mediaType?: string }>;
        };
      }>;
    }>;
    const toolResult = messages
      .find((message) => message.role === "tool")
      ?.content?.find((part) => part.output?.type === "content")?.output;

    expect(toolResult?.value).toContainEqual({
      type: "image-data",
      data: "iVBORw0KGgo=",
      mediaType: "image/png"
    });
  });
});

// ── tool-call preservation (no default pruning) ─────────────────

describe("Think — tool call preservation", () => {
  it("preserves earlier client-side tool results across turns", async () => {
    // Regression for cloudflare/agents#1455. Think no longer applies
    // `pruneMessages` by default, so client-side tool outputs (whose
    // user choices live in the assistant tool-result part) survive
    // follow-up turns and reach the model. Subclasses that want the
    // old aggressive pruning can apply it themselves in `beforeTurn`.
    const agent = await freshAgent("preserve-client-tools");
    for (let i = 0; i < 3; i++) {
      await agent.persistTestMessage({
        id: `u-${i}`,
        role: "user",
        parts: [{ type: "text", text: `question ${i}` }]
      });
      await agent.persistTestMessage({
        id: `a-${i}`,
        role: "assistant",
        parts: [
          {
            type: "tool-clientChoice",
            toolCallId: `tc-${i}`,
            state: "output-available",
            input: { question: `q${i}` },
            output: `user-choice-${i}`
          } as UIMessage["parts"][number]
        ]
      });
    }

    await agent.testChat("follow up");

    const json = await agent.getLastBeforeTurnMessagesJson();
    expect(json).not.toBeNull();
    expect(json).toContain("user-choice-0");
    expect(json).toContain("user-choice-1");
    expect(json).toContain("user-choice-2");
  });
});

// ── saveMessages ─────────────────────────────────────────────────

describe("Think — saveMessages", () => {
  it("should inject messages and run a turn", async () => {
    const agent = await freshProgrammaticAgent("save-basic");

    const result = (await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Scheduled prompt" }]
      }
    ])) as SaveMessagesResult;

    expect(result.status).toBe("completed");
    expect(result.requestId).toBeTruthy();

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("should support function form", async () => {
    const agent = await freshProgrammaticAgent("save-fn");

    // First turn via RPC
    await agent.testChat("Hello");

    // Second turn via saveMessages with function form
    const result = (await agent.testSaveMessagesWithFn(
      "Follow-up"
    )) as SaveMessagesResult;
    expect(result.status).toBe("completed");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);
    expect(messages[2].role).toBe("user");
    expect(messages[3].role).toBe("assistant");
  });

  it("should fire onChatResponse", async () => {
    const agent = await freshProgrammaticAgent("save-hook");

    await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Trigger hook" }]
      }
    ]);

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("completed");
    expect(log[0].continuation).toBe(false);
  });

  it("should return error status for in-band stream errors", async () => {
    const agent = await freshProgrammaticAgent("save-inband-error");
    await agent.setInBandStreamErrorResponse("saveMessages in-band failure");

    const result = (await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Trigger in-band error" }]
      }
    ])) as SaveMessagesResult;

    expect(result.status).toBe("error");

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("error");
    expect(log[0].error).toContain("saveMessages in-band failure");
  });

  it("should broadcast to connected clients", async () => {
    const agent = await freshProgrammaticAgent("save-broadcast");

    await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Broadcast test" }]
      }
    ]);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
  });
});

// ── continueLastTurn ─────────────────────────────────────────────

describe("Think — continueLastTurn", () => {
  it("should continue from the last assistant message", async () => {
    const agent = await freshProgrammaticAgent("continue-basic");

    await agent.testChat("Start conversation");
    const messagesBefore = (await agent.getStoredMessages()) as UIMessage[];
    expect(messagesBefore).toHaveLength(2);

    const result = (await agent.testContinueLastTurn()) as SaveMessagesResult;
    expect(result.status).toBe("completed");

    const messagesAfter = (await agent.getStoredMessages()) as UIMessage[];
    expect(messagesAfter.length).toBeGreaterThan(2);
  });

  it("should skip when no assistant message exists", async () => {
    const agent = await freshProgrammaticAgent("continue-skip");

    const result = (await agent.testContinueLastTurn()) as SaveMessagesResult;
    expect(result.status).toBe("skipped");
    expect(result.requestId).toBe("");
  });

  it("should set continuation: true on continueLastTurn", async () => {
    const agent = await freshProgrammaticAgent("continue-flag");

    await agent.testChat("Start");

    await agent.testContinueLastTurn();

    const options = (await agent.getCapturedOptions()) as Array<{
      continuation?: boolean;
    }>;
    const lastOption = options[options.length - 1];
    expect(lastOption.continuation).toBe(true);
  });

  it("should fire onChatResponse with continuation: true", async () => {
    const agent = await freshProgrammaticAgent("continue-hook");

    await agent.testChat("Start");
    await agent.testContinueLastTurn();

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log.length).toBeGreaterThanOrEqual(2);
    const lastHook = log[log.length - 1];
    expect(lastHook.continuation).toBe(true);
    expect(lastHook.status).toBe("completed");
  });

  it("should accept custom body", async () => {
    const agent = await freshProgrammaticAgent("continue-body");

    await agent.testChat("Start");
    await agent.testContinueLastTurnWithBody({ model: "fast" });

    const options = (await agent.getCapturedOptions()) as Array<{
      body?: Record<string, unknown>;
    }>;
    const lastOption = options[options.length - 1];
    expect(lastOption.body).toEqual({ model: "fast" });
  });
});

// ── External abort signal (issue #1406) ─────────────────────────
//
// `Think.saveMessages` and `continueLastTurn` accept an
// `AbortSignal` via the `options.signal` argument. The signal is
// linked to the registry's controller for the turn — when it
// aborts, the inference loop's signal aborts, partial chunks are
// persisted, and the result reports `status: "aborted"`. Pre-aborted
// signals short-circuit before any model work runs.

describe("Think — saveMessages with external AbortSignal", () => {
  it("runs to completion when the signal is never aborted", async () => {
    const agent = await freshProgrammaticAgent("ext-abort-completes");

    const result = await agent.testSaveMessagesWithSignal("Run normally", {});
    expect(result.status).toBe("completed");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
  });

  it("returns status: 'aborted' when the signal is pre-aborted", async () => {
    const agent = await freshProgrammaticAgent("ext-abort-pre");
    // Use a delayed model so the chunk loop has time to observe the
    // pre-aborted signal — without delays the loop completes faster
    // than the abort propagation, masking the early-cancel path.
    await agent.setDelayedChunkResponse(["a ", "b ", "c ", "d "], 50);

    const result = await agent.testSaveMessagesWithSignal("Cancel before run", {
      preAbort: true
    });

    expect(result.status).toBe("aborted");
    expect(result.requestId).toBeTruthy();

    // The user message persists (it's saved before the abort gate),
    // but the assistant message is either entirely missing OR has
    // strictly fewer parts than a full response.
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].role).toBe("user");
  });

  it("returns status: 'aborted' when aborted mid-stream", async () => {
    const agent = await freshProgrammaticAgent("ext-abort-mid");
    await agent.setDelayedChunkResponse(
      ["chunk1 ", "chunk2 ", "chunk3 ", "chunk4 ", "chunk5 "],
      50
    );

    const { result, persistedMessageCount, lastResponseStatus } =
      await agent.testSaveMessagesAbortMidStream("Long response", 100);

    expect(result.status).toBe("aborted");
    // The onChatResponse hook fires with status: "aborted" too.
    expect(lastResponseStatus).toBe("aborted");
    // Both user and partial assistant messages should be persisted.
    expect(persistedMessageCount).toBe(2);
  });

  it("post-completion abort is a no-op (no leaked listener)", async () => {
    const agent = await freshProgrammaticAgent("ext-abort-post");

    const result = await agent.testSaveMessagesWithSignal("Run then abort", {
      abortAfterCompletion: true
    });

    // Aborting AFTER completion does not flip the status — the
    // detacher in `linkExternal` removed the listener cleanly.
    expect(result.status).toBe("completed");

    // Registry is empty after a clean completion.
    const count = await agent.getAbortControllerCount();
    expect(count).toBe(0);
  });

  it("public abortAllRequests() cancels a programmatic turn the same way", async () => {
    const agent = await freshProgrammaticAgent("ext-abort-public");
    await agent.setDelayedChunkResponse(["a ", "b ", "c ", "d ", "e "], 50);

    const result = await agent.testSaveMessagesCancelledByAbortAllRequests(
      "Cancel via public method",
      100
    );

    expect(result.status).toBe("aborted");
  });

  it("registry remains empty after aborted turns (no controller leak)", async () => {
    const agent = await freshProgrammaticAgent("ext-abort-leak");
    await agent.setDelayedChunkResponse(["x ", "y ", "z "], 50);

    await agent.testSaveMessagesWithSignal("Pre-abort 1", { preAbort: true });
    await agent.testSaveMessagesWithSignal("Pre-abort 2", { preAbort: true });
    await agent.testSaveMessagesAbortMidStream("Mid abort", 50);

    const count = await agent.getAbortControllerCount();
    expect(count).toBe(0);
  });

  it("subsequent saveMessages calls succeed after an aborted turn", async () => {
    const agent = await freshProgrammaticAgent("ext-abort-recover");
    await agent.setDelayedChunkResponse(["1 ", "2 ", "3 ", "4 "], 50);

    const aborted = await agent.testSaveMessagesAbortMidStream("Abort me", 75);
    expect(aborted.result.status).toBe("aborted");

    await agent.clearDelayedChunkResponse();
    const followUp = (await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Normal turn" }]
      }
    ])) as SaveMessagesResult;

    expect(followUp.status).toBe("completed");
  });

  it("continueLastTurn returns 'aborted' when the signal fires mid-stream", async () => {
    const agent = await freshProgrammaticAgent("ext-abort-continue");
    // Seed an assistant message via a normal chat first.
    await agent.testChat("seed");

    await agent.setDelayedChunkResponse(["x ", "y ", "z ", "w ", "v "], 50);
    const result = await agent.testContinueLastTurnWithSignal({
      abortAfterMs: 100
    });

    expect(result.status).toBe("aborted");
  });

  it("continueLastTurn pre-aborted yields 'aborted'", async () => {
    const agent = await freshProgrammaticAgent("ext-abort-continue-pre");
    await agent.testChat("seed");

    const result = await agent.testContinueLastTurnWithSignal({
      preAbort: true
    });

    expect(result.status).toBe("aborted");
  });
});

// ── Custom body persistence ──────────────────────────────────────

describe("Think — body persistence", () => {
  it("should pass body from continueLastTurn", async () => {
    const agent = await freshProgrammaticAgent("body-continue");

    await agent.testChat("Start");
    await agent.testContinueLastTurnWithBody({
      model: "fast",
      temperature: 0.5
    });

    const options = (await agent.getCapturedOptions()) as Array<{
      body?: Record<string, unknown>;
    }>;
    const lastOption = options[options.length - 1];
    expect(lastOption.body).toEqual({ model: "fast", temperature: 0.5 });
  });

  it("should default to undefined when no body set", async () => {
    const agent = await freshProgrammaticAgent("body-default");

    await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "No body" }]
      }
    ]);

    const options = (await agent.getCapturedOptions()) as Array<{
      body?: Record<string, unknown>;
    }>;
    expect(options[0].body).toBeUndefined();
  });
});

// ── chatRecovery ────────────────────────────────────────

describe("Think — chatRecovery", () => {
  it("chat turn with recovery=true works normally and cleans up fibers", async () => {
    const agent = await freshRecoveryAgent("recovery-basic");

    await agent.testChat("Hello!");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");

    const fibers = await agent.getActiveFibers();
    expect(fibers).toHaveLength(0);

    expect(await agent.getTurnCallCount()).toBe(1);
  });

  it("recovery=false works without creating fiber rows", async () => {
    const agent = await freshNonRecoveryAgent("nonrecovery-basic");

    await agent.testChat("Hello!");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);

    const fibers = await agent.getActiveFibers();
    expect(fibers).toHaveLength(0);
  });

  it("behavioral parity: same messages regardless of recovery flag", async () => {
    const durableAgent = await freshRecoveryAgent("parity-durable");
    const nonDurableAgent = await freshNonRecoveryAgent("parity-nondurable");

    await durableAgent.testChat("Hello");
    await nonDurableAgent.testChat("Hello");

    const durableMessages =
      (await durableAgent.getStoredMessages()) as UIMessage[];
    const nonDurableMessages =
      (await nonDurableAgent.getStoredMessages()) as UIMessage[];

    expect(durableMessages.length).toBe(nonDurableMessages.length);
    expect(durableMessages.map((m: UIMessage) => m.role)).toEqual(
      nonDurableMessages.map((m: UIMessage) => m.role)
    );
  });

  it("stash() is callable during a durable saveMessages turn", async () => {
    const agent = await freshRecoveryAgent("stash-basic");

    await agent.setStashData({ responseId: "resp-123", provider: "openai" });
    await agent.testSaveMessages("Hello via saveMessages");

    const stashResult = await agent.getStashResult();
    expect(stashResult).not.toBeNull();
    expect(stashResult!.success).toBe(true);

    const fibers = await agent.getActiveFibers();
    expect(fibers).toHaveLength(0);
  });

  it("stash() is callable during a durable chat() turn", async () => {
    const agent = await freshRecoveryAgent("stash-chat");

    await agent.setStashData({ responseId: "resp-chat", provider: "test" });
    await agent.testChat("Hello via durable chat");

    const stashResult = await agent.getStashResult();
    expect(stashResult).not.toBeNull();
    expect(stashResult!.success).toBe(true);

    const fibers = await agent.getActiveFibers();
    expect(fibers).toHaveLength(0);
  });

  it("chat() records stream chunks for recovery lookup", async () => {
    const agent = await freshRecoveryAgent("chat-stream-metadata");

    const result = await agent.testChat("Record the stream");
    expect(result.done).toBe(true);

    const snapshot = await agent.getLatestStreamSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.status).toBe("completed");
    expect(snapshot!.chunkCount).toBeGreaterThan(0);
    expect(snapshot!.text).toBe("Continued response.");
  });

  it("saveMessages with recovery wraps in fiber and cleans up", async () => {
    const agent = await freshRecoveryAgent("save-fiber");

    const result = (await agent.testSaveMessages(
      "Programmatic hello"
    )) as SaveMessagesResult;
    expect(result.status).toBe("completed");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);

    const fibers = await agent.getActiveFibers();
    expect(fibers).toHaveLength(0);
  });

  it("multiple sequential turns don't leak fibers", async () => {
    const agent = await freshRecoveryAgent("multi-turn-fiber");

    await agent.testChat("First");
    await agent.testChat("Second");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);

    const fibers = await agent.getActiveFibers();
    expect(fibers).toHaveLength(0);

    expect(await agent.getTurnCallCount()).toBe(2);
  });
});

// ── onChatRecovery ───────────────────────────────────────────────

describe("Think — onChatRecovery", () => {
  it("fires onChatRecovery for an interrupted fiber", async () => {
    const agent = await freshRecoveryAgent("recovery-hook");

    await agent.setRecoveryOverride({ continue: false });

    await agent.insertInterruptedStream("stream-1", "req-1", [
      {
        body: JSON.stringify({ type: "start", messageId: "assistant-1" }),
        index: 0
      },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Partial text" }),
        index: 2
      }
    ]);
    const before = Date.now();
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-1");

    await agent.triggerFiberRecovery();

    const contexts = (await agent.getRecoveryContexts()) as Array<{
      recoveryData: unknown;
      partialText: string;
      streamId: string;
      createdAt: number;
    }>;
    expect(contexts.length).toBeGreaterThanOrEqual(1);

    const ctx = contexts[contexts.length - 1];
    expect(ctx).toMatchObject({
      incidentId: "req-1:",
      attempt: 1,
      maxAttempts: 10,
      recoveryKind: "continue"
    });
    expect(ctx.partialText).toBe("Partial text");
    expect(ctx.streamId).toBe("stream-1");
    expect(typeof ctx.createdAt).toBe("number");
    expect(ctx.createdAt).toBeGreaterThanOrEqual(before);
    expect(ctx.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it("exhausts chat recovery after the configured max attempts", async () => {
    const agent = await freshRecoveryAgent("recovery-exhaustion");

    await agent.setChatRecoveryConfigForTest({
      maxAttempts: 1,
      terminalMessage: "gave up"
    });
    await agent.setRecoveryOverride({ continue: false });

    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-exhaust");
    await agent.triggerFiberRecovery();
    // Age the incident past the alarm-debounce window so the second recovery
    // counts as a genuinely separate attempt (not a collapsed reconnect-storm
    // alarm) — otherwise debounce keeps it at attempt 1 (#1637).
    await agent.ageIncidentForTest("req-exhaust:", 40_000);
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-exhaust");
    await agent.triggerFiberRecovery();

    const contexts = await agent.getRecoveryContexts();
    expect(contexts).toHaveLength(1);

    const incidents = (await agent.getChatRecoveryIncidentsForTest()) as Array<{
      attempt: number;
      maxAttempts: number;
      status: string;
      reason?: string;
    }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      attempt: 2,
      maxAttempts: 1,
      status: "exhausted",
      reason: "max_attempts_exceeded"
    });
  });

  it("continuation does not replay a trailing assistant message (assistant prefill)", async () => {
    const agent = await freshRecoveryAgent("continuation-prefill");

    // A deploy-interrupted turn leaves a partial assistant message as the latest
    // leaf; `continueLastTurn` replays it. Modern models (Claude 4.6+) reject a
    // request that ends in an assistant message with a 400.
    await agent.seedPartialAssistantTurnForTest();
    const result = await agent.runContinueWithPrefillRejectingModelForTest();

    // The model must never receive a request ending in an assistant message;
    // the continuation should append a user checkpoint and complete.
    expect(await agent.getLastPromptRoleForTest()).not.toBe("assistant");
    expect(result.status).toBe("completed");
  });

  it("replays a terminal error to a reconnecting client (hydration)", async () => {
    const agent = await freshRecoveryAgent("terminal-hydration");

    // A turn that errored. The live error broadcast is transient — a client
    // disconnected at that moment (e.g. during a WS reconnect storm) misses it.
    await agent.fireResponseHookForTest({
      requestId: "r-fail",
      status: "error",
      error: "boom"
    });

    // On (re)connect, the client must learn the turn failed instead of seeing
    // only the current messages with no terminal signal (frozen UI).
    const onConnect = (await agent.getIdleConnectMessagesForTest()) as Array<{
      type: string;
      id?: string;
      error?: boolean;
      done?: boolean;
    }>;
    const terminal = onConnect.find((m) => m.error === true && m.done === true);
    expect(terminal).toBeTruthy();
    expect(terminal?.id).toBe("r-fail");

    // A subsequent completed turn resolves it — no stale error replayed.
    await agent.fireResponseHookForTest({
      requestId: "r-ok",
      status: "completed"
    });
    const afterOk = (await agent.getIdleConnectMessagesForTest()) as Array<{
      error?: boolean;
    }>;
    expect(afterOk.some((m) => m.error === true)).toBe(false);
  });

  it("flushes a settled tool result to durable storage immediately", async () => {
    const agent = await freshRecoveryAgent("tool-result-durability");

    const { bufferedTextCount, afterToolOutputCount } =
      await agent.probeToolResultDurabilityForTest();

    // Streamed text after the first flush stays buffered in memory (throttled).
    expect(bufferedTextCount).toBe(1);
    // A settled tool result forces an immediate flush, so it (and the buffered
    // text) are durable before the stream completes — surviving an eviction
    // that would otherwise lose the result and re-run the (non-idempotent) tool.
    expect(afterToolOutputCount).toBeGreaterThan(bufferedTextCount);
  });

  it("replays a pre-stream error to a reconnecting client (hydration)", async () => {
    const agent = await freshRecoveryAgent("pre-stream-hydration");

    // A turn that fails before streaming starts (e.g. message reconciliation).
    // The error broadcast is transient — a client disconnected at that moment
    // misses it, so it must be persisted for replay on reconnect.
    await agent.simulatePreStreamChatFailureForTest({
      requestId: "r-prestream",
      userText: "hello",
      error: "pre-stream boom"
    });

    const onConnect = (await agent.getIdleConnectMessagesForTest()) as Array<{
      id?: string;
      body?: string;
      error?: boolean;
      done?: boolean;
    }>;
    const terminal = onConnect.find((m) => m.error === true && m.done === true);
    expect(terminal).toBeTruthy();
    expect(terminal?.id).toBe("r-prestream");
    expect(terminal?.body).toContain("pre-stream boom");
  });

  it("resets the attempt budget when recovery makes forward progress", async () => {
    const agent = await freshRecoveryAgent("recovery-progress-reset");
    await agent.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const base = {
      requestId: "req-prog",
      recoveryRootRequestId: "req-prog",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    // Space attempts >30s apart so alarm-debounce (#1637) doesn't collapse
    // them; controlled clock keeps it deterministic.
    let t = 1_000_000;
    const at = () => {
      const nowMs = t;
      t += 40_000;
      return { ...base, nowMs };
    };

    // Two debounce-spaced detections with no progress climb toward the cap.
    expect((await agent.beginIncidentForTest(at())).attempt).toBe(1);
    expect((await agent.beginIncidentForTest(at())).attempt).toBe(2);

    // Forward progress (the durable counter advances, as `_persistOrphanedStream`
    // does after materializing a partial) resets the budget — the deploy-churn fix.
    await agent.bumpRecoveryProgressForTest();
    const afterProgress = await agent.beginIncidentForTest(at());
    expect(afterProgress.attempt).toBe(1);
    expect(afterProgress.exhausted).toBe(false);

    // Without further progress it climbs again and still exhausts at the cap.
    expect((await agent.beginIncidentForTest(at())).attempt).toBe(2);
    const exhausted = await agent.beginIncidentForTest(at());
    expect(exhausted.attempt).toBe(3);
    expect(exhausted.exhausted).toBe(true);
  });

  it("credits forwarding a sub-agent's stream as parent forward progress (N9)", async () => {
    const agent = await freshRecoveryAgent("recovery-n9-child-progress");
    await agent.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const base = {
      requestId: "req-n9",
      recoveryRootRequestId: "req-n9",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    let t = 1_000_000;
    const at = () => {
      const nowMs = t;
      t += 40_000;
      return { ...base, nowMs };
    };

    // A parent whose turn merely awaits a sub-agent climbs toward the cap.
    expect((await agent.beginIncidentForTest(at())).attempt).toBe(1);
    expect((await agent.beginIncidentForTest(at())).attempt).toBe(2);

    // Re-attaching and forwarding the child's stream IS the parent's forward
    // progress (N9) — the durable marker advances through the real
    // `_forwardAgentToolStream` path, so the budget resets just like in-band
    // content does. Without this, the deploy-churn parent exhausts at `attempt
    // 6/6, progress: 1` while the child streams healthily.
    const forwarded = await agent.forwardChildStreamProgressForTest(3);
    expect(forwarded.after).toBe(forwarded.start + 1);
    const afterChildStream = await agent.beginIncidentForTest(at());
    expect(afterChildStream.attempt).toBe(1);
    expect(afterChildStream.exhausted).toBe(false);
  });

  it("does NOT credit a silent/hung sub-agent, so the parent still exhausts (N9)", async () => {
    const agent = await freshRecoveryAgent("recovery-n9-silent-child");
    await agent.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const base = {
      requestId: "req-n9-silent",
      recoveryRootRequestId: "req-n9-silent",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    let t = 2_000_000;
    const at = () => {
      const nowMs = t;
      t += 40_000;
      return { ...base, nowMs };
    };

    expect((await agent.beginIncidentForTest(at())).attempt).toBe(1);
    expect((await agent.beginIncidentForTest(at())).attempt).toBe(2);

    // A re-attach where the child produces NO output forwards nothing, so the
    // parent banks no progress and the cap still binds — a genuinely hung child
    // must not pin the parent's recovery open forever.
    const forwarded = await agent.forwardChildStreamProgressForTest(0);
    expect(forwarded.after).toBe(forwarded.start);
    const exhausted = await agent.beginIncidentForTest(at());
    expect(exhausted.attempt).toBe(3);
    expect(exhausted.exhausted).toBe(true);
  });

  it("detects forward progress even after compaction collapses the transcript (#1628)", async () => {
    const agent = await freshRecoveryAgent("recovery-progress-compaction");
    await agent.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const base = {
      requestId: "req-compact",
      recoveryRootRequestId: "req-compact",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };

    // First detection opens the incident.
    expect(
      (await agent.beginIncidentForTest({ ...base, nowMs: 1_000_000 })).attempt
    ).toBe(1);

    // The turn advances (a partial is materialized) AND compaction then
    // collapses every assistant message out of the live transcript. The old
    // message-count marker would now read FEWER messages than the previous
    // attempt and miss the progress; the durable counter is immune.
    await agent.bumpRecoveryProgressForTest();
    await agent.dropAssistantMessagesForTest();

    const afterProgress = await agent.beginIncidentForTest({
      ...base,
      nowMs: 1_040_000
    });
    expect(afterProgress.attempt).toBe(1);
    expect(afterProgress.exhausted).toBe(false);
  });

  it("exhausts via the wall-clock window even while making progress", async () => {
    const agent = await freshRecoveryAgent("recovery-window");
    await agent.setChatRecoveryConfigForTest({ maxAttempts: 6 });

    // An incident that opened more than the 15-minute window ago.
    await agent.seedIncidentForTest({
      incidentId: "req-old:u1",
      requestId: "req-old",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now() - 16 * 60 * 1000,
      lastAttemptAt: Date.now() - 1000
    });

    // Even with fresh progress, the wall-clock ceiling terminalizes it.
    await agent.bumpRecoveryProgressForTest();
    const next = await agent.beginIncidentForTest({
      requestId: "req-old-2",
      recoveryRootRequestId: "req-old",
      latestUserMessageId: "u1",
      recoveryKind: "continue"
    });
    expect(next.exhausted).toBe(true);

    const incidents = (await agent.getChatRecoveryIncidentsForTest()) as Array<{
      status: string;
      reason?: string;
    }>;
    expect(incidents[0]).toMatchObject({
      status: "exhausted",
      reason: "max_recovery_window_exceeded"
    });
  });

  it("seals an incident after the no-progress window even below the attempt cap (#1637)", async () => {
    const agent = await freshRecoveryAgent("recovery-no-progress");
    // High cap so the no-progress wall clock — not the attempt count — is what binds.
    await agent.setChatRecoveryConfigForTest({ maxAttempts: 100 });

    const base = {
      requestId: "req-np",
      recoveryRootRequestId: "req-np",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 2_000_000;
    // First detection opens the incident; not yet exhausted.
    expect(
      (await agent.beginIncidentForTest({ ...base, nowMs: t0 })).exhausted
    ).toBe(false);

    // A later alarm past the 5-min no-progress window, with no progress in
    // between, seals it — even though the attempt count is far below the cap.
    const past = await agent.beginIncidentForTest({
      ...base,
      nowMs: t0 + 6 * 60 * 1000
    });
    expect(past.exhausted).toBe(true);
    expect(past.reason).toBe("no_progress_timeout");
  });

  it("collapses a rollout's reconnect storm into one attempt via debounce (#1637)", async () => {
    const agent = await freshRecoveryAgent("recovery-debounce");
    await agent.setChatRecoveryConfigForTest({ maxAttempts: 2 });

    const base = {
      requestId: "req-db",
      recoveryRootRequestId: "req-db",
      latestUserMessageId: "u1",
      recoveryKind: "continue" as const
    };
    const t0 = 3_000_000;

    // First alarm opens the incident (attempt 1).
    expect(
      (await agent.beginIncidentForTest({ ...base, nowMs: t0 })).attempt
    ).toBe(1);

    // A burst of alarms within the debounce window (one rollout's reconnects)
    // must NOT advance the attempt count.
    expect(
      (await agent.beginIncidentForTest({ ...base, nowMs: t0 + 5_000 })).attempt
    ).toBe(1);
    expect(
      (await agent.beginIncidentForTest({ ...base, nowMs: t0 + 12_000 }))
        .attempt
    ).toBe(1);
    expect(
      (await agent.beginIncidentForTest({ ...base, nowMs: t0 + 20_000 }))
        .attempt
    ).toBe(1);

    // An alarm beyond the debounce window is a genuinely separate attempt.
    const later = await agent.beginIncidentForTest({
      ...base,
      nowMs: t0 + 60_000
    });
    expect(later.attempt).toBe(2);
    expect(later.exhausted).toBe(false);
  });

  it("advances progress on durable flush but not on an orphan re-persist (reconnect-immune, #1637)", async () => {
    const agent = await freshRecoveryAgent("recovery-progress-immunity");

    const { start, afterFlush, afterPersist } =
      await agent.probeProgressReconnectImmunityForTest();

    // Streaming new content durably flushed → progress advanced.
    expect(afterFlush).toBeGreaterThan(start);
    // Re-persisting that same content (a recovery/reconnect would) must NOT be
    // miscounted as new progress — otherwise a reconnecting client could reset
    // the no-progress window of a stuck turn forever.
    expect(afterPersist).toBe(afterFlush);
  });

  it("shares one attempt budget when an incident flips between retry and continue", async () => {
    const agent = await freshRecoveryAgent("recovery-kind-flip");

    const first = await agent.beginIncidentForTest({
      requestId: "req-flip",
      recoveryRootRequestId: "req-flip",
      latestUserMessageId: "user-flip",
      recoveryKind: "retry",
      nowMs: 1_000_000
    });
    const second = await agent.beginIncidentForTest({
      requestId: "req-flip-2",
      recoveryRootRequestId: "req-flip",
      latestUserMessageId: "user-flip",
      recoveryKind: "continue",
      // >30s after the first so alarm-debounce doesn't collapse the attempt.
      nowMs: 1_040_000
    });

    // Same identity despite the kind change, so the attempt budget accrues.
    expect(first.incidentId).toBe("req-flip:user-flip");
    expect(second.incidentId).toBe("req-flip:user-flip");
    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);

    const incidents = await agent.getChatRecoveryIncidentsForTest();
    expect(incidents).toHaveLength(1);
  });

  it("deletes the incident record once recovery completes", async () => {
    const agent = await freshRecoveryAgent("recovery-completed-cleanup");

    const incident = await agent.beginIncidentForTest({
      requestId: "req-done",
      recoveryRootRequestId: "req-done",
      latestUserMessageId: "user-done",
      recoveryKind: "continue"
    });
    expect(await agent.getChatRecoveryIncidentsForTest()).toHaveLength(1);

    await agent.updateIncidentForTest(incident.incidentId, "completed");

    expect(await agent.getChatRecoveryIncidentsForTest()).toHaveLength(0);
  });

  it("sweeps incidents that have been inactive past the TTL", async () => {
    const agent = await freshRecoveryAgent("recovery-stale-sweep");

    const staleAt = Date.now() - 2 * 60 * 60 * 1000;
    await agent.seedIncidentForTest({
      incidentId: "stale:user",
      requestId: "stale",
      recoveryKind: "continue",
      attempt: 3,
      maxAttempts: 6,
      status: "failed",
      firstSeenAt: staleAt,
      lastAttemptAt: staleAt
    });
    expect(await agent.getChatRecoveryIncidentsForTest()).toHaveLength(1);

    // Opening any new incident triggers the stale sweep.
    await agent.beginIncidentForTest({
      requestId: "req-fresh",
      recoveryRootRequestId: "req-fresh",
      latestUserMessageId: "user-fresh",
      recoveryKind: "continue"
    });

    const incidents = (await agent.getChatRecoveryIncidentsForTest()) as Array<{
      incidentId: string;
    }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].incidentId).toBe("req-fresh:user-fresh");
  });

  it("marks the incident failed when onChatRecovery throws", async () => {
    const agent = await freshRecoveryAgent("recovery-hook-throws");

    await agent.setRecoveryShouldThrowForTest(true);

    const failed: string[] = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:recovery:failed") {
        failed.push(event.payload.incidentId);
      }
    });

    try {
      await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-throw");
      await agent.triggerFiberRecovery();
    } finally {
      unsubscribe();
    }

    const incidents = (await agent.getChatRecoveryIncidentsForTest()) as Array<{
      status: string;
      reason?: string;
    }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].status).toBe("failed");
    expect(incidents[0].reason).toContain("onChatRecovery boom");
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  it("still delivers terminal UX when onExhausted throws", async () => {
    const agent = await freshRecoveryAgent("recovery-exhausted-throws");

    await agent.enableThrowingOnExhaustedForTest(1, "gave up");
    await agent.setRecoveryOverride({ continue: false });

    const fiberFailures: string[] = [];
    const unsubscribe = subscribe("fiber", (event) => {
      if (event.type === "fiber:recovery:failed") {
        fiberFailures.push(event.payload.fiberId);
      }
    });

    try {
      await agent.insertInterruptedFiber(
        "__cf_internal_chat_turn:req-ex-throw"
      );
      await agent.triggerFiberRecovery();
      // Past the alarm-debounce window → a genuinely separate attempt (#1637).
      await agent.ageIncidentForTest("req-ex-throw:", 40_000);
      await agent.insertInterruptedFiber(
        "__cf_internal_chat_turn:req-ex-throw"
      );
      await agent.triggerFiberRecovery();
    } finally {
      unsubscribe();
    }

    // The throwing hook ran, but it did not propagate out of recovery (which
    // would have surfaced as a fiber recovery failure and skipped terminal UX).
    expect(await agent.getOnExhaustedCallsForTest()).toBe(1);
    expect(fiberFailures).toHaveLength(0);

    const incidents = (await agent.getChatRecoveryIncidentsForTest()) as Array<{
      status: string;
    }>;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].status).toBe("exhausted");
  });

  it("stashed data round-trips through fiber recovery", async () => {
    const agent = await freshRecoveryAgent("stash-roundtrip");

    await agent.setRecoveryOverride({ continue: false });

    const stashedData = { responseId: "resp-xyz", model: "gpt-4" };

    await agent.insertInterruptedStream("stream-stash", "req-stash", [
      {
        body: JSON.stringify({ type: "start", messageId: "a-stash" }),
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
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-stash",
      stashedData
    );

    await agent.triggerFiberRecovery();

    const contexts = (await agent.getRecoveryContexts()) as Array<{
      recoveryData: unknown;
      partialText: string;
      streamId: string;
    }>;
    expect(contexts.length).toBeGreaterThanOrEqual(1);

    const ctx = contexts[contexts.length - 1];
    expect(ctx.recoveryData).toEqual(stashedData);
    expect(ctx.partialText).toBe("Partial with stash");
  });

  it("recovers a pre-stream interrupted chat fiber from its early snapshot", async () => {
    const agent = await freshRecoveryAgent("pre-stream-recovery");

    await agent.persistTestMessage({
      id: "u-pre-stream",
      role: "user",
      parts: [{ type: "text", text: "Recover this unanswered message" }]
    });

    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-pre-stream",
      {
        __cfThinkChatFiberSnapshot: {
          kind: "think-chat-turn",
          version: 1,
          requestId: "req-pre-stream",
          continuation: false,
          latestMessageId: "u-pre-stream",
          latestMessageRole: "user",
          latestUserMessageId: "u-pre-stream",
          startedAt: Date.now()
        },
        user: { providerRequestId: "provider-pre-stream" }
      }
    );

    await agent.triggerFiberRecovery();

    const contexts = (await agent.getRecoveryContexts()) as Array<{
      recoveryData: unknown;
      partialText: string;
      streamId: string;
    }>;
    const ctx = contexts[contexts.length - 1];

    expect(ctx.streamId).toBe("");
    expect(ctx.partialText).toBe("");
    expect(ctx.recoveryData).toEqual({
      providerRequestId: "provider-pre-stream"
    });
  });

  it("retries a pre-stream interrupted user turn by default without duplicating the user message", async () => {
    const agent = await freshRecoveryAgent(
      `pre-stream-retry-${crypto.randomUUID()}`
    );

    await agent.persistTestMessage({
      id: "u-retry",
      role: "user",
      parts: [{ type: "text", text: "Retry this unanswered message" }]
    });

    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-retry", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "req-retry",
        continuation: false,
        latestMessageId: "u-retry",
        latestMessageRole: "user",
        latestUserMessageId: "u-retry",
        startedAt: Date.now(),
        lastBody: { mode: "snapshot" }
      },
      user: null
    });

    await agent.triggerFiberRecovery();
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryRetry")
    ).toBe(1);
    await agent.runScheduledRecoveryRetryForTest();

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(messages[0].id).toBe("u-retry");
    expect(
      messages[1].parts
        .filter((part): part is { type: "text"; text: string } => {
          return part.type === "text" && "text" in part;
        })
        .map((part) => part.text)
        .join("")
    ).toBe("Continued response.");
    expect(await agent.getTurnBodies()).toEqual([{ mode: "snapshot" }]);
  });

  it("continues a partial stream with request context from the recovered snapshot", async () => {
    const agent = await freshRecoveryAgent(
      `partial-continue-context-${crypto.randomUUID()}`
    );

    await agent.persistTestMessage({
      id: "u-continue",
      role: "user",
      parts: [{ type: "text", text: "Continue this partial answer" }]
    });
    await agent.persistTestMessage({
      id: "a-continue",
      role: "assistant",
      parts: [{ type: "text", text: "Partial answer" }]
    });

    await agent.insertInterruptedStream("stream-continue", "req-continue", [
      {
        body: JSON.stringify({ type: "start", messageId: "a-continue" }),
        index: 0
      },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Partial answer" }),
        index: 2
      }
    ]);
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-continue", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "req-continue",
        continuation: false,
        latestMessageId: "a-continue",
        latestMessageRole: "assistant",
        latestUserMessageId: "u-continue",
        startedAt: Date.now(),
        lastBody: { mode: "snapshot" },
        lastClientTools: [{ name: "snapshotTool", description: "Snapshot" }]
      },
      user: null
    });

    await agent.triggerFiberRecovery();
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(1);

    await agent.setRequestContextForTest({ mode: "stale" }, [
      { name: "staleTool", description: "Stale" }
    ]);
    await agent.runScheduledRecoveryContinueForTest();

    expect(await agent.getTurnBodies()).toEqual([{ mode: "snapshot" }]);
    expect((await agent.getTurnClientToolNames())[0]).toContain("snapshotTool");
    expect((await agent.getTurnClientToolNames())[0]).not.toContain(
      "staleTool"
    );
  });

  it("{ continue: false } persists but does not schedule continuation", async () => {
    const agent = await freshRecoveryAgent("no-continue");

    await agent.setRecoveryOverride({ continue: false });

    await agent.insertInterruptedStream("stream-nc", "req-nc", [
      {
        body: JSON.stringify({ type: "start", messageId: "a-nc" }),
        index: 0
      },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Partial" }),
        index: 2
      }
    ]);
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-nc");

    await agent.triggerFiberRecovery();

    expect(await agent.getTurnCallCount()).toBe(0);
  });

  it("{ continue: false } surfaces a terminal error on reconnect", async () => {
    const agent = await freshRecoveryAgent("no-continue-terminal");

    await agent.setRecoveryOverride({ continue: false });

    await agent.insertInterruptedStream("stream-nct", "req-nct", [
      {
        body: JSON.stringify({ type: "start", messageId: "a-nct" }),
        index: 0
      },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Partial" }),
        index: 2
      }
    ]);
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-nct");

    await agent.triggerFiberRecovery();

    // Disabling recovery abandons the turn with no superseding turn, so a
    // reconnecting client must see a terminal error rather than a frozen,
    // half-streamed turn (unlike a benign `conversation_changed` skip).
    const onConnect = (await agent.getIdleConnectMessagesForTest()) as Array<{
      body?: string;
      error?: boolean;
      done?: boolean;
    }>;
    const terminal = onConnect.find((m) => m.error === true && m.done === true);
    expect(terminal).toBeTruthy();
    expect(terminal?.body).toContain("chat recovery was disabled");
  });

  // ── Recovery under multi-deploy churn (chained continuations) ──────────────

  it("schedules chained continuations against the recovery root submission, not the per-continuation requestId", async () => {
    const agent = await freshRecoveryAgent(
      `chain-ownership-${crypto.randomUUID()}`
    );

    // A running submission keyed by the recovery ROOT request id.
    await agent.seedRunningSubmissionForTest("root-1");
    await agent.persistTestMessage({
      id: "u-1",
      role: "user",
      parts: [{ type: "text", text: "do it" }]
    });
    await agent.persistTestMessage({
      id: "a-1",
      role: "assistant",
      parts: [{ type: "text", text: "Partial" }]
    });

    // A continuation turn (requestId "cont-2", DIFFERENT from the root) is
    // interrupted mid-stream. Its snapshot carries the recovery root.
    await agent.insertInterruptedStream("stream-2", "cont-2", [
      { body: JSON.stringify({ type: "start", messageId: "a-1" }), index: 0 },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Partial" }),
        index: 2
      }
    ]);
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:cont-2", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "cont-2",
        recoveryRootRequestId: "root-1",
        continuation: true,
        latestMessageId: "a-1",
        latestMessageRole: "assistant",
        latestUserMessageId: "u-1",
        startedAt: Date.now()
      },
      user: null
    });

    await agent.triggerFiberRecovery();

    // The scheduled continuation must still own the submission via the stable
    // root id — otherwise the continuation that completes the turn can never
    // mark the submission done (the bug under deploy churn).
    const payload = await agent.getScheduledChatRecoveryPayloadForTest(
      "_chatRecoveryContinue"
    );
    expect(payload?.recoveredRequestId).toBe("root-1");
  });

  it("marks the root submission errored when a chained continuation is abandoned (recovery disabled)", async () => {
    const agent = await freshRecoveryAgent(
      `chain-disabled-${crypto.randomUUID()}`
    );
    // Disabling recovery routes the interrupted continuation through
    // `_markRecoveredSubmissionInterrupted`, which must key off the recovery
    // ROOT (root-1) — the submission row still carries root-1, so passing the
    // per-continuation id (cont-2) would miss it and leave it stuck `running`.
    await agent.setRecoveryOverride({ continue: false });
    await agent.seedRunningSubmissionForTest("root-1");
    await agent.persistTestMessage({
      id: "u-1",
      role: "user",
      parts: [{ type: "text", text: "do it" }]
    });
    await agent.persistTestMessage({
      id: "a-1",
      role: "assistant",
      parts: [{ type: "text", text: "Partial" }]
    });

    await agent.insertInterruptedStream("stream-2", "cont-2", [
      { body: JSON.stringify({ type: "start", messageId: "a-1" }), index: 0 },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", delta: "Partial" }),
        index: 2
      }
    ]);
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:cont-2", {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "cont-2",
        recoveryRootRequestId: "root-1",
        continuation: true,
        latestMessageId: "a-1",
        latestMessageRole: "assistant",
        latestUserMessageId: "u-1",
        startedAt: Date.now()
      },
      user: null
    });

    await agent.triggerFiberRecovery();

    expect(await agent.getSubmissionStatusForTest("root-1")).toBe("error");
  });

  it("a superseded continuation (leaf moved to another assistant message) skips benignly without erroring the submission", async () => {
    const agent = await freshRecoveryAgent(`superseded-${crypto.randomUUID()}`);
    await agent.seedRunningSubmissionForTest("root-A");
    // Leaf is a NEWER assistant message — recovery's own forward progress.
    await agent.persistTestMessage({
      id: "a-new",
      role: "assistant",
      parts: [{ type: "text", text: "progressed" }]
    });
    await agent.seedIncidentForTest({
      incidentId: "inc-A",
      requestId: "root-A",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    await agent.runChatRecoveryContinueForTestWith({
      recoveredRequestId: "root-A",
      targetAssistantId: "a-old-superseded",
      incidentId: "inc-A",
      originalRequestId: "root-A"
    });

    // Must NOT clobber the submission to error — the active continuation will
    // complete it.
    expect(await agent.getSubmissionStatusForTest("root-A")).toBe("running");
  });

  it("a genuinely superseding user turn marks the submission skipped, not errored", async () => {
    const agent = await freshRecoveryAgent(`newuser-${crypto.randomUUID()}`);
    await agent.seedRunningSubmissionForTest("root-B");
    // Leaf is a USER message — a genuinely newer turn.
    await agent.persistTestMessage({
      id: "u-new",
      role: "user",
      parts: [{ type: "text", text: "new question" }]
    });
    await agent.seedIncidentForTest({
      incidentId: "inc-B",
      requestId: "root-B",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    await agent.runChatRecoveryContinueForTestWith({
      recoveredRequestId: "root-B",
      targetAssistantId: "a-old",
      incidentId: "inc-B",
      originalRequestId: "root-B"
    });

    expect(await agent.getSubmissionStatusForTest("root-B")).toBe("skipped");
  });

  it("reschedules a continuation that times out waiting for stable state, within the attempt budget", async () => {
    const agent = await freshRecoveryAgent(
      `stable-retry-${crypto.randomUUID()}`
    );
    await agent.setForceStableTimeoutForTest(true);
    await agent.seedRunningSubmissionForTest("root-C");
    await agent.seedIncidentForTest({
      incidentId: "inc-C",
      requestId: "root-C",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    const continueData = {
      recoveredRequestId: "root-C",
      targetAssistantId: "a-x",
      incidentId: "inc-C",
      originalRequestId: "root-C"
    };
    // Simulate the currently-executing one-shot schedule row (which `alarm()`
    // deletes only after the callback returns). A buggy idempotent reschedule
    // would dedup onto this and then vanish with it, stalling recovery.
    await agent.preScheduleRecoveryContinueForTest(continueData);

    await agent.runChatRecoveryContinueForTestWith(continueData);

    // The reschedule must create a NEW row (2 total), not dedup onto the
    // executing one — otherwise the retry silently never fires.
    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(2);
    expect(await agent.getSubmissionStatusForTest("root-C")).toBe("running");
    const incident = await agent.getIncidentAttemptForTest("inc-C");
    expect(incident?.attempt).toBe(2);
    expect(incident?.status).toBe("scheduled");
  });

  it("reschedules a pre-stream retry that times out waiting for stable state, within the attempt budget", async () => {
    const agent = await freshRecoveryAgent(
      `stable-retry-pre-${crypto.randomUUID()}`
    );
    await agent.setForceStableTimeoutForTest(true);
    await agent.seedRunningSubmissionForTest("root-R");
    await agent.seedIncidentForTest({
      incidentId: "inc-R",
      requestId: "root-R",
      recoveryKind: "retry",
      attempt: 1,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    const retryData = {
      recoveredRequestId: "root-R",
      targetUserId: "u-x",
      incidentId: "inc-R",
      originalRequestId: "root-R"
    };
    // Simulate the executing one-shot row so a buggy idempotent reschedule
    // would dedup onto it and vanish (the `_chatRecoveryRetry` twin of the
    // continue-path test — guards the now-shared reschedule helper).
    await agent.preScheduleRecoveryRetryForTest(retryData);

    await agent.runChatRecoveryRetryForTestWith(retryData);

    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryRetry")
    ).toBe(2);
    expect(await agent.getSubmissionStatusForTest("root-R")).toBe("running");
    const incident = await agent.getIncidentAttemptForTest("inc-R");
    expect(incident?.attempt).toBe(2);
    expect(incident?.status).toBe("scheduled");
  });

  it("fails terminally once the stable-state retry budget is exhausted", async () => {
    const agent = await freshRecoveryAgent(
      `stable-exhaust-${crypto.randomUUID()}`
    );
    await agent.setForceStableTimeoutForTest(true);
    await agent.seedRunningSubmissionForTest("root-D");
    await agent.seedIncidentForTest({
      incidentId: "inc-D",
      requestId: "root-D",
      recoveryKind: "continue",
      attempt: 6,
      maxAttempts: 6,
      status: "scheduled",
      firstSeenAt: Date.now(),
      lastAttemptAt: Date.now()
    });

    await agent.runChatRecoveryContinueForTestWith({
      recoveredRequestId: "root-D",
      targetAssistantId: "a-x",
      incidentId: "inc-D",
      originalRequestId: "root-D"
    });

    expect(
      await agent.getScheduledChatRecoveryCountForTest("_chatRecoveryContinue")
    ).toBe(0);
    expect(await agent.getSubmissionStatusForTest("root-D")).toBe("error");
    const incident = await agent.getIncidentAttemptForTest("inc-D");
    expect(incident?.status).toBe("failed");
  });

  it("re-reconstructing the same interrupted stream is idempotent (no duplicate, no loss)", async () => {
    const agent = await freshRecoveryAgent(`dup-${crypto.randomUUID()}`);
    // continue:false isolates the orphan-persist behavior from continuation.
    await agent.setRecoveryOverride({ continue: false });
    await agent.persistTestMessage({
      id: "u-dup",
      role: "user",
      parts: [{ type: "text", text: "do it" }]
    });
    const snapshot = {
      __cfThinkChatFiberSnapshot: {
        kind: "think-chat-turn",
        version: 1,
        requestId: "req-dup",
        continuation: false,
        latestMessageId: "a-dup",
        latestMessageRole: "assistant",
        latestUserMessageId: "u-dup",
        startedAt: Date.now()
      },
      user: null
    };
    const chunks = [
      { body: JSON.stringify({ type: "start", messageId: "a-dup" }), index: 0 },
      { body: JSON.stringify({ type: "text-start", id: "t" }), index: 1 },
      {
        body: JSON.stringify({ type: "text-delta", id: "t", delta: "Partial" }),
        index: 2
      }
    ];

    await agent.insertInterruptedStream(
      "stream-dup",
      "req-dup",
      chunks,
      "error"
    );
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-dup",
      snapshot
    );
    await agent.triggerFiberRecovery();

    const afterFirst = (await agent.getStoredMessages()) as UIMessage[];
    expect(afterFirst.filter((m) => m.role === "assistant")).toHaveLength(1);

    // Simulate a SECOND eviction re-detecting the same fiber before the first
    // recovery's cleanup deleted it (the `_persistOrphanedStream` window).
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-dup",
      snapshot
    );
    await agent.triggerFiberRecovery();

    const afterSecond = (await agent.getStoredMessages()) as UIMessage[];
    const assistants = afterSecond.filter((m) => m.role === "assistant");
    // Stable message id (from the `start` chunk) + upsert-by-id ⇒ a replace,
    // not a duplicate — and the completed content is never lost.
    expect(assistants).toHaveLength(1);
    expect(assistants[0].id).toBe("a-dup");
  });

  it("does not continue a recovered chat fiber whose stream already completed", async () => {
    const agent = await freshRecoveryAgent("completed-stream-recovery");

    await agent.insertInterruptedStream(
      "stream-completed",
      "req-completed",
      [
        {
          body: JSON.stringify({
            type: "start",
            messageId: "a-completed"
          }),
          index: 0
        },
        { body: JSON.stringify({ type: "text-start" }), index: 1 },
        {
          body: JSON.stringify({
            type: "text-delta",
            delta: "Already done"
          }),
          index: 2
        },
        { body: JSON.stringify({ type: "text-end" }), index: 3 },
        { body: JSON.stringify({ type: "finish" }), index: 4 }
      ],
      "completed"
    );
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-completed");

    await agent.triggerFiberRecovery();

    expect(await agent.getTurnCallCount()).toBe(0);
    expect(await agent.getScheduledChatRecoveryCountForTest()).toBe(0);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(
      messages[0].parts
        .filter((part): part is { type: "text"; text: string } => {
          return part.type === "text" && "text" in part;
        })
        .map((part) => part.text)
        .join("")
    ).toBe("Already done");
  });

  it("does not duplicate an already-persisted completed stream on recovery", async () => {
    const agent = await freshRecoveryAgent("completed-stream-existing-message");

    await agent.persistTestMessage({
      id: "a-existing-completed",
      role: "assistant",
      parts: [{ type: "text", text: "Already persisted" }]
    });
    await agent.insertInterruptedStream(
      "stream-existing-completed",
      "req-existing-completed",
      [
        {
          body: JSON.stringify({
            type: "start",
            messageId: "a-existing-completed"
          }),
          index: 0
        },
        { body: JSON.stringify({ type: "text-start" }), index: 1 },
        {
          body: JSON.stringify({
            type: "text-delta",
            delta: "Already persisted"
          }),
          index: 2
        },
        { body: JSON.stringify({ type: "text-end" }), index: 3 },
        { body: JSON.stringify({ type: "finish" }), index: 4 }
      ],
      "completed"
    );
    await agent.insertInterruptedFiber(
      "__cf_internal_chat_turn:req-existing-completed"
    );

    await agent.triggerFiberRecovery();

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("a-existing-completed");
    expect(messages[0].role).toBe("assistant");
    expect(
      messages[0].parts
        .filter((part): part is { type: "text"; text: string } => {
          return part.type === "text" && "text" in part;
        })
        .map((part) => part.text)
        .join("")
    ).toBe("Already persisted");
  });

  it("{ persist: false, continue: false } skips both", async () => {
    const agent = await freshRecoveryAgent("skip-both");

    await agent.setRecoveryOverride({ persist: false, continue: false });

    await agent.insertInterruptedStream("stream-skip", "req-skip", [
      {
        body: JSON.stringify({ type: "start", messageId: "a-skip" }),
        index: 0
      },
      { body: JSON.stringify({ type: "text-start" }), index: 1 },
      {
        body: JSON.stringify({
          type: "text-delta",
          delta: "Should not persist"
        }),
        index: 2
      }
    ]);
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-skip");

    await agent.triggerFiberRecovery();

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(0);
    expect(await agent.getTurnCallCount()).toBe(0);
  });

  it("persists the settled partial when the recovery budget is exhausted (#1631)", async () => {
    const agent = await freshRecoveryAgent("exhaust-preserves-partial");
    // maxAttempts: 1 so a seeded attempt at the cap exhausts on the next wake.
    await agent.setChatRecoveryConfigForTest({ maxAttempts: 1 });

    // Terminal stream carrying a settled partial: text PLUS a completed
    // (settled, non-idempotent) tool call — the exact work the budget-exhaustion
    // path used to discard, forcing the model to re-run it on the next message.
    await agent.insertInterruptedStream(
      "stream-exh",
      "req-exh",
      [
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
      ],
      "completed"
    );
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-exh");

    // Seed an incident already at the cap so this recovery exhausts. The
    // incident id is `<recoveryRootRequestId>:<latestUserMessageId>` — here the
    // root is the requestId and there is no latest user message.
    // `lastAttemptAt` is aged past the alarm-debounce window (#1637/#1638) so
    // this wake counts as a genuine new attempt (1 → 2 > maxAttempts) rather
    // than being collapsed as a debounced reconnect (which would hold the
    // attempt at 1 and never exhaust).
    await agent.seedIncidentForTest({
      incidentId: "req-exh:",
      requestId: "req-exh",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 1,
      status: "scheduled",
      firstSeenAt: Date.now() - 60_000,
      lastAttemptAt: Date.now() - 60_000
    });

    await agent.triggerFiberRecovery();

    // Exhaustion seals the turn but must NOT discard the settled partial — the
    // bug was that `_exhaustChatRecovery` returned before persisting it.
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    const text = messages[0].parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toContain("did real work");
    // The settled tool result is preserved (not just the text) — it's the
    // non-idempotent work the model would otherwise re-run.
    const settledTool = messages[0].parts.find((p) => {
      const part = p as { type?: unknown; output?: unknown; state?: unknown };
      return (
        typeof part.type === "string" &&
        part.type.startsWith("tool-") &&
        (part.output !== undefined || part.state === "output-available")
      );
    });
    expect(settledTool).toBeDefined();

    // And the incident is recorded as exhausted.
    const incidents = (await agent.getChatRecoveryIncidentsForTest()) as Array<{
      status: string;
    }>;
    expect(incidents[0]?.status).toBe("exhausted");
  });

  it("never drops settled tool results on { persist: false } — preserves them anyway (#1631)", async () => {
    const agent = await freshRecoveryAgent("persist-false-preserves-settled");
    await agent.setRecoveryOverride({ persist: false, continue: false });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Terminal stream (so the persist gate is reached) carrying a SETTLED
      // tool result — the non-idempotent work `persist: false` must NOT drop.
      await agent.insertInterruptedStream(
        "stream-settled",
        "req-settled",
        [
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
        ],
        "completed"
      );
      await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-settled");

      await agent.triggerFiberRecovery();

      // R1: settled work is preserved regardless of `persist: false` — the
      // assistant partial carrying the completed tool call IS persisted, and
      // there is no warning (a safe default beats a warning about an unsafe one).
      const messages = (await agent.getStoredMessages()) as UIMessage[];
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");
      const hasSettledTool = messages[0].parts.some((p) => {
        const type = (p as { type?: unknown }).type;
        return typeof type === "string" && type.startsWith("tool-");
      });
      expect(hasSettledTool).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("honors { persist: false } for a text-only partial with no settled work (#1631)", async () => {
    const agent = await freshRecoveryAgent("persist-false-text-only");
    await agent.setRecoveryOverride({ persist: false, continue: false });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await agent.insertInterruptedStream(
        "stream-textonly",
        "req-textonly",
        [
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
        ],
        "completed"
      );
      await agent.insertInterruptedFiber(
        "__cf_internal_chat_turn:req-textonly"
      );

      await agent.triggerFiberRecovery();

      // No settled tool results to preserve, so `persist: false` is honored —
      // nothing is persisted, and there is no warning.
      const messages = (await agent.getStoredMessages()) as UIMessage[];
      expect(messages).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("exposes recoveryRootRequestId on the onChatRecovery context (#1631)", async () => {
    const agent = await freshRecoveryAgent("recovery-root-id");

    await agent.insertInterruptedStream("stream-root", "req-root", [
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
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-root");

    await agent.triggerFiberRecovery();

    // Cast the RPC return to the shape under test — the stub type machinery
    // collapses these complex recovery-context returns to `never` at the call
    // site (same quirk handled elsewhere in these tests).
    const contexts = (await agent.getRecoveryContexts()) as Array<{
      recoveryRootRequestId: string;
    }>;
    expect(contexts.length).toBeGreaterThanOrEqual(1);
    // The stable incident root (constant across chained continuations) is now a
    // first-class field — no re-deriving identity from message IDs.
    expect(contexts[0]?.recoveryRootRequestId).toBe("req-root");
  });

  it("onExhausted context carries terminalMessage, recoveryRootRequestId, and the partial (#1631)", async () => {
    const agent = await freshRecoveryAgent("exhausted-ctx");
    await agent.enableExhaustedCaptureForTest(1);

    await agent.insertInterruptedStream(
      "stream-exctx",
      "req-exctx",
      [
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
      ],
      "completed"
    );
    await agent.insertInterruptedFiber("__cf_internal_chat_turn:req-exctx");
    // `lastAttemptAt` aged past the alarm-debounce window (#1637/#1638) so this
    // wake counts as a genuine new attempt (1 → 2 > maxAttempts) and exhausts,
    // rather than being collapsed as a debounced reconnect.
    await agent.seedIncidentForTest({
      incidentId: "req-exctx:",
      requestId: "req-exctx",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 1,
      status: "scheduled",
      firstSeenAt: Date.now() - 60_000,
      lastAttemptAt: Date.now() - 60_000
    });

    await agent.triggerFiberRecovery();

    const exhausted = (await agent.getExhaustedContextsForTest()) as Array<{
      recoveryRootRequestId: string;
      terminalMessage: string;
      partialText: string;
      reason: string;
      streamId: string;
      createdAt: number;
    }>;
    expect(exhausted).toHaveLength(1);
    const ctx = exhausted[0];
    // Enough to render/persist a terminal banner AND emit correlated telemetry
    // without re-deriving anything (the streamId + createdAt let a consumer
    // compute msSinceTurnStart and correlate the failure — D4).
    expect(ctx.recoveryRootRequestId).toBe("req-exctx");
    expect(ctx.terminalMessage.length).toBeGreaterThan(0);
    expect(ctx.partialText).toContain("work before giving up");
    expect(ctx.reason).toBe("max_attempts_exceeded");
    expect(ctx.streamId).toBe("stream-exctx");
    expect(typeof ctx.createdAt).toBe("number");
    expect(ctx.createdAt).toBeGreaterThan(0);
  });

  it("routes a stall through the SAME exhaustion path as deploy recovery once the budget is spent — fires onExhausted + delivers terminalMessage, not the raw stall error (#1626)", async () => {
    const agent = await freshRecoveryAgent("stall-route-exhaust");
    const terminalMessage = "The assistant was interrupted. Please try again.";
    const result = await agent.testStallRouteExhaustion(1, terminalMessage);

    // The route reports exhaustion (not "scheduled"/"disabled")...
    expect(result.outcome).toBe("exhausted");
    // ...routed through `_exhaustChatRecovery` (deploy-recovery's path), so the
    // configured `onExhausted` hook fired exactly once with the right reason...
    expect(result.exhaustedContexts).toBe(1);
    expect(result.exhaustedReason).toBe("max_attempts_exceeded");
    // ...the incident is durably sealed `exhausted`...
    expect(result.incidentStatus).toBe("exhausted");
    // ...and the user sees the CONFIGURED terminalMessage, not the raw
    // "Chat stream stalled..." error.
    expect(result.terminalBroadcast).toBe(terminalMessage);
  });
});

// ── waitUntilStable / hasPendingInteraction ───────────────────────

describe("Think — waitUntilStable", () => {
  it("returns true immediately when no pending interactions", async () => {
    const agent = await freshRecoveryAgent("stable-immediate");

    const stable = await agent.waitUntilStableForTest(1000);
    expect(stable).toBe(true);
  });

  it("returns true when no turns are active", async () => {
    const agent = await freshRecoveryAgent("stable-idle");

    await agent.testChat("Hello");

    const stable = await agent.waitUntilStableForTest(1000);
    expect(stable).toBe(true);
  });

  it("detects pending tool interaction", async () => {
    const agent = await freshRecoveryAgent("stable-pending");

    await agent.persistTestMessage({
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Use a tool" }]
    } as UIMessage);

    await agent.persistTestMessage({
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-client_action",
          toolCallId: "tc-1",
          toolName: "client_action",
          state: "input-available",
          input: { action: "test" }
        }
      ]
    } as unknown as UIMessage);

    const hasPending = await agent.hasPendingInteractionForTest();
    expect(hasPending).toBe(true);
  });

  it("detects pending approval", async () => {
    const agent = await freshRecoveryAgent("stable-approval");

    await agent.persistTestMessage({
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Approve something" }]
    } as UIMessage);

    await agent.persistTestMessage({
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-calculate",
          toolCallId: "tc-1",
          toolName: "calculate",
          state: "approval-requested",
          input: { a: 5000, b: 3000, operator: "+" },
          approval: { id: "approval-1" }
        }
      ]
    } as unknown as UIMessage);

    const hasPending = await agent.hasPendingInteractionForTest();
    expect(hasPending).toBe(true);
  });

  it("returns false when no pending after tool result applied", async () => {
    const agent = await freshRecoveryAgent("stable-resolved");

    await agent.persistTestMessage({
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Done" }]
    } as UIMessage);

    await agent.persistTestMessage({
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-client_action",
          toolCallId: "tc-1",
          toolName: "client_action",
          state: "output-available",
          input: { action: "test" },
          output: "result"
        }
      ]
    } as unknown as UIMessage);

    const hasPending = await agent.hasPendingInteractionForTest();
    expect(hasPending).toBe(false);
  });
});

// ── Async onChatResponse ─────────────────────────────────────────

describe("Think — async onChatResponse", () => {
  it("does not drop results during rapid sequential turns", async () => {
    const agent = await freshAsyncHookAgent("async-hook-rapid");

    await agent.setHookDelay(50);

    await agent.testChat("Turn 1");
    await agent.testChat("Turn 2");
    await agent.testChat("Turn 3");

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(3);
    expect(log[0].status).toBe("completed");
    expect(log[1].status).toBe("completed");
    expect(log[2].status).toBe("completed");
  });

  it("awaits async hook before next turn starts", async () => {
    const agent = await freshAsyncHookAgent("async-hook-await");

    await agent.setHookDelay(100);

    await agent.testChat("First");
    await agent.testChat("Second");

    const log = (await agent.getResponseLog()) as ChatResponseResult[];
    expect(log).toHaveLength(2);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(4);
  });
});
