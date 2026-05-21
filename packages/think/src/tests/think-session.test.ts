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
  ThinkNonRecoveryTestAgent
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

  it("should throw RPC in-band stream errors when no onError callback exists", async () => {
    const agent = await freshAgent("hook-rpc-inband-error-no-callback");

    await agent.setInBandErrorResponse("RPC missing callback error");
    const error = await agent.testChatWithoutErrorCallback(
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
    expect(ctx.partialText).toBe("Partial text");
    expect(ctx.streamId).toBe("stream-1");
    expect(typeof ctx.createdAt).toBe("number");
    expect(ctx.createdAt).toBeGreaterThanOrEqual(before);
    expect(ctx.createdAt).toBeLessThanOrEqual(Date.now());
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
