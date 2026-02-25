import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import type { Env } from "../../../worker";
import { getAgentByName } from "../../../..";
import type {
  AIMessage,
  MessageQueryOptions
} from "../../../../experimental/memory/session";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Typed stub interface to avoid deep RPC type inference issues.
 * This matches the TestSessionAgent's public methods.
 */
interface SessionAgentStub {
  getMessages(): Promise<AIMessage[]>;
  getMessagesWithOptions(options: MessageQueryOptions): Promise<AIMessage[]>;
  appendMessage(message: AIMessage): Promise<void>;
  appendMessages(messages: AIMessage[]): Promise<void>;
  updateMessage(message: AIMessage): Promise<void>;
  deleteMessages(ids: string[]): Promise<void>;
  clearMessages(): Promise<void>;
  countMessages(): Promise<number>;
  getMessage(id: string): Promise<AIMessage | null>;
  getLastMessages(n: number): Promise<AIMessage[]>;
}

/** Helper to get a typed agent stub */
async function getSessionAgent(name: string): Promise<SessionAgentStub> {
  return getAgentByName(
    env.TestSessionAgent,
    name
  ) as unknown as Promise<SessionAgentStub>;
}

describe("AgentSessionProvider", () => {
  let instanceName: string;

  // Use a fresh instance name for each test to avoid state pollution
  beforeEach(() => {
    instanceName = `session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  describe("basic operations", () => {
    it("should start with no messages", async () => {
      const agent = await getSessionAgent(instanceName);
      const messages = await agent.getMessages();

      expect(messages).toEqual([]);
    });

    it("should append and retrieve a single message", async () => {
      const agent = await getSessionAgent(instanceName);

      const message: AIMessage = {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Hello, world!" }]
      };

      await agent.appendMessage(message);
      const messages = await agent.getMessages();

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-1");
      expect(messages[0].role).toBe("user");
      expect(messages[0].parts[0]).toEqual({
        type: "text",
        text: "Hello, world!"
      });
    });

    it("should append multiple messages at once", async () => {
      const agent = await getSessionAgent(instanceName);

      const messages: AIMessage[] = [
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi there!" }]
        },
        {
          id: "msg-3",
          role: "user",
          parts: [{ type: "text", text: "How are you?" }]
        }
      ];

      await agent.appendMessages(messages);
      const retrieved = await agent.getMessages();

      expect(retrieved).toHaveLength(3);
      expect(retrieved.map((m) => m.id)).toEqual(["msg-1", "msg-2", "msg-3"]);
    });

    it("should count messages correctly", async () => {
      const agent = await getSessionAgent(instanceName);

      expect(await agent.countMessages()).toBe(0);

      await agent.appendMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }]
      });
      expect(await agent.countMessages()).toBe(1);

      await agent.appendMessage({
        id: "msg-2",
        role: "assistant",
        parts: [{ type: "text", text: "Hi" }]
      });
      expect(await agent.countMessages()).toBe(2);
    });

    it("should get a single message by ID", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        }
      ]);

      const message = await agent.getMessage("msg-2");
      expect(message).not.toBeNull();
      expect(message?.id).toBe("msg-2");
      expect(message?.role).toBe("assistant");

      const notFound = await agent.getMessage("nonexistent");
      expect(notFound).toBeNull();
    });

    it("should get the last N messages", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        },
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "Third" }] },
        {
          id: "msg-4",
          role: "assistant",
          parts: [{ type: "text", text: "Fourth" }]
        }
      ]);

      const lastTwo = await agent.getLastMessages(2);
      expect(lastTwo).toHaveLength(2);
      expect(lastTwo.map((m) => m.id)).toEqual(["msg-3", "msg-4"]);
    });
  });

  describe("update and delete", () => {
    it("should update an existing message", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Original" }]
      });

      await agent.updateMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Updated" }]
      });

      const messages = await agent.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].parts[0]).toEqual({ type: "text", text: "Updated" });
    });

    it("should upsert on append with existing ID", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Original" }]
      });

      // Appending with same ID should update
      await agent.appendMessage({
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Replaced" }]
      });

      const messages = await agent.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].parts[0]).toEqual({ type: "text", text: "Replaced" });
    });

    it("should delete messages by ID", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        },
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "Third" }] }
      ]);

      await agent.deleteMessages(["msg-2"]);

      const messages = await agent.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.id)).toEqual(["msg-1", "msg-3"]);
    });

    it("should delete multiple messages", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        },
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "Third" }] }
      ]);

      await agent.deleteMessages(["msg-1", "msg-3"]);

      const messages = await agent.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-2");
    });

    it("should clear all messages", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        }
      ]);

      await agent.clearMessages();

      const messages = await agent.getMessages();
      expect(messages).toEqual([]);
      expect(await agent.countMessages()).toBe(0);
    });
  });

  describe("query options", () => {
    it("should limit results", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        },
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "Third" }] }
      ]);

      const messages = await agent.getMessagesWithOptions({ limit: 2 });
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    });

    it("should offset results", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "First" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Second" }]
        },
        { id: "msg-3", role: "user", parts: [{ type: "text", text: "Third" }] }
      ]);

      const messages = await agent.getMessagesWithOptions({ offset: 1 });
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.id)).toEqual(["msg-2", "msg-3"]);
    });

    it("should filter by role", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "User 1" }]
        },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Assistant 1" }]
        },
        {
          id: "msg-3",
          role: "user",
          parts: [{ type: "text", text: "User 2" }]
        },
        {
          id: "msg-4",
          role: "assistant",
          parts: [{ type: "text", text: "Assistant 2" }]
        }
      ]);

      const userMessages = await agent.getMessagesWithOptions({ role: "user" });
      expect(userMessages).toHaveLength(2);
      expect(userMessages.every((m) => m.role === "user")).toBe(true);

      const assistantMessages = await agent.getMessagesWithOptions({
        role: "assistant"
      });
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages.every((m) => m.role === "assistant")).toBe(true);
    });

    it("should combine limit, offset, and role filters", async () => {
      const agent = await getSessionAgent(instanceName);

      await agent.appendMessages([
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "User 1" }]
        },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Assistant 1" }]
        },
        {
          id: "msg-3",
          role: "user",
          parts: [{ type: "text", text: "User 2" }]
        },
        {
          id: "msg-4",
          role: "assistant",
          parts: [{ type: "text", text: "Assistant 2" }]
        },
        { id: "msg-5", role: "user", parts: [{ type: "text", text: "User 3" }] }
      ]);

      const messages = await agent.getMessagesWithOptions({
        role: "user",
        offset: 1,
        limit: 1
      });
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-3");
    });
  });

  describe("message parts", () => {
    it("should store messages with tool invocation parts", async () => {
      const agent = await getSessionAgent(instanceName);

      const message: AIMessage = {
        id: "msg-1",
        role: "assistant",
        parts: [
          { type: "text", text: "Let me help you with that." },
          {
            type: "tool-invocation",
            toolCallId: "call-1",
            toolName: "get_weather",
            args: { city: "San Francisco" },
            state: "output-available",
            output: { temperature: 65, condition: "sunny" }
          }
        ]
      };

      await agent.appendMessage(message);
      const retrieved = await agent.getMessage("msg-1");

      expect(retrieved?.parts).toHaveLength(2);
      expect(retrieved?.parts[0]).toEqual({
        type: "text",
        text: "Let me help you with that."
      });
      expect(retrieved?.parts[1]).toMatchObject({
        type: "tool-invocation",
        toolCallId: "call-1",
        toolName: "get_weather"
      });
    });

    it("should store messages with metadata", async () => {
      const agent = await getSessionAgent(instanceName);

      const message: AIMessage = {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
        metadata: {
          model: "claude-3",
          tokens: 150,
          custom: { important: true }
        }
      };

      await agent.appendMessage(message);
      const retrieved = await agent.getMessage("msg-1");

      expect(retrieved?.metadata).toEqual({
        model: "claude-3",
        tokens: 150,
        custom: { important: true }
      });
    });

    it("should store messages with reasoning parts", async () => {
      const agent = await getSessionAgent(instanceName);

      const message: AIMessage = {
        id: "msg-1",
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "I should think about this carefully..."
          },
          { type: "text", text: "Here is my answer." }
        ]
      };

      await agent.appendMessage(message);
      const retrieved = await agent.getMessage("msg-1");

      expect(retrieved?.parts).toHaveLength(2);
      expect(retrieved?.parts[0]).toMatchObject({
        type: "reasoning",
        text: "I should think about this carefully..."
      });
    });

    it("should handle system messages", async () => {
      const agent = await getSessionAgent(instanceName);

      const message: AIMessage = {
        id: "system-1",
        role: "system",
        parts: [{ type: "text", text: "You are a helpful assistant." }]
      };

      await agent.appendMessage(message);
      const messages = await agent.getMessagesWithOptions({ role: "system" });

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("system");
    });
  });

  describe("persistence across instances", () => {
    it("should persist messages across agent instance lookups", async () => {
      // First instance - add messages
      const agent1 = await getSessionAgent(instanceName);
      await agent1.appendMessages([
        { id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
        {
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi there!" }]
        }
      ]);

      // Second instance lookup - should see same messages
      const agent2 = await getSessionAgent(instanceName);
      const messages = await agent2.getMessages();

      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    });
  });
});
