import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { getAgentByName } from "agents";
import { MessageType } from "../types";

describe("Oversized rows and incremental persistence", () => {
  describe("Incremental persistence", () => {
    it("persists new messages and skips unchanged ones on second call", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Persist two messages
      const messages: ChatMessage[] = [
        {
          id: "inc-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        },
        {
          id: "inc-2",
          role: "assistant",
          parts: [{ type: "text", text: "Hi there!" }]
        }
      ];

      await agentStub.persistMessages(messages);

      let persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(2);

      // Persist the same messages again -- should be a no-op in SQL
      // (we can't directly observe SQL write count, but we can verify
      // the messages are still correct)
      await agentStub.persistMessages(messages);

      persisted = (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(2);
      expect(persisted[0].id).toBe("inc-1");
      expect(persisted[1].id).toBe("inc-2");

      ws.close(1000);
    });

    it("persists modified messages when content changes", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Persist initial message
      await agentStub.persistMessages([
        {
          id: "mod-1",
          role: "assistant",
          parts: [{ type: "text", text: "Original" }]
        }
      ]);

      // Modify the message
      await agentStub.persistMessages([
        {
          id: "mod-1",
          role: "assistant",
          parts: [{ type: "text", text: "Updated content" }]
        }
      ]);

      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(1);
      const textPart = persisted[0].parts[0] as { text: string };
      expect(textPart.text).toBe("Updated content");

      ws.close(1000);
    });

    it("writes nothing when persisting an unchanged transcript", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const messages: ChatMessage[] = [
        { id: "noop-1", role: "user", parts: [{ type: "text", text: "Hi" }] },
        {
          id: "noop-2",
          role: "assistant",
          parts: [{ type: "text", text: "Hello" }]
        }
      ];

      // Arm the change-feed counter, then take the baseline after the writes
      // that actually change storage.
      await agentStub.sessionChangeEventCountForTest();
      await agentStub.persistMessages(messages);
      const afterFirstWrite = await agentStub.sessionChangeEventCountForTest();
      expect(afterFirstWrite).toBeGreaterThan(0);

      // Re-persisting identical rows is a no-op: Sessions skips the row write
      // and dispatches no change event.
      await agentStub.persistMessages(messages);
      expect(await agentStub.sessionChangeEventCountForTest()).toBe(
        afterFirstWrite
      );
      expect(
        ((await agentStub.getPersistedMessages()) as ChatMessage[]).map(
          (m) => m.id
        )
      ).toEqual(["noop-1", "noop-2"]);
      expect(
        ((await agentStub.getMessagesForTest()) as ChatMessage[]).map(
          (m) => m.id
        )
      ).toEqual(["noop-1", "noop-2"]);

      ws.close(1000);
    });

    it("re-accepts a cleared message id", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Persist a message
      await agentStub.persistMessages([
        {
          id: "clear-cache-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        }
      ]);

      // Clear via WebSocket
      ws.send(JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR }));
      await new Promise((r) => setTimeout(r, 100));

      // Verify cleared
      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(0);

      // Persist a new message with the same ID -- should succeed
      await agentStub.persistMessages([
        {
          id: "clear-cache-1",
          role: "user",
          parts: [{ type: "text", text: "New message same ID" }]
        }
      ]);

      const afterPersist =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(afterPersist.length).toBe(1);
      expect((afterPersist[0].parts[0] as { text: string }).text).toBe(
        "New message same ID"
      );

      ws.close(1000);
    });
  });

  describe("Oversized rows offload losslessly", () => {
    it("messages under 1.8MB pass through unchanged", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // Create a message with a moderately large tool output (50KB)
      const toolOutput = "A".repeat(50_000);
      const message: ChatMessage = {
        id: "size-ok",
        role: "assistant",
        parts: [
          {
            type: "tool-bigTool",
            toolCallId: "call_ok",
            state: "output-available",
            input: {},
            output: toolOutput
          }
        ] as ChatMessage["parts"]
      };

      await agentStub.persistMessages([message]);

      const persisted =
        (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(persisted.length).toBe(1);

      // Output should be preserved at full fidelity (under 1.8MB)
      const part = persisted[0].parts[0] as { output: unknown };
      expect(part.output).toBe(toolOutput);

      ws.close(1000);
    });

    it("splits an oversized tool output across rows and reads it back byte-for-byte", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // A tool output that cannot fit one SQLite row. Sessions splits the
      // message across continuation rows instead of truncating it.
      const hugeOutput = "X".repeat(1_900_000);
      const message: ChatMessage = {
        id: "size-big",
        role: "assistant",
        parts: [
          {
            type: "tool-hugeTool",
            toolCallId: "call_huge",
            state: "output-available",
            input: { query: "big data" },
            output: hugeOutput
          }
        ] as ChatMessage["parts"]
      };

      await agentStub.persistMessages([message]);

      const stored = (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(stored.length).toBe(1);
      expect((stored[0].parts[0] as { output: unknown }).output).toBe(
        hugeOutput
      );
      expect(await agentStub.continuationRowCountForTest()).toBeGreaterThan(0);

      // No compaction metadata is stamped: nothing was lost.
      expect(stored[0].metadata).toBeUndefined();

      ws.close(1000);
    });

    it("stores an oversized user text part losslessly", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const largeText = "Z".repeat(1_900_000);
      const message: ChatMessage = {
        id: "user-big",
        role: "user",
        parts: [{ type: "text", text: largeText }]
      };

      await agentStub.persistMessages([message]);

      const stored = (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(stored.length).toBe(1);
      expect((stored[0].parts[0] as { text: string }).text).toBe(largeText);
      expect(await agentStub.continuationRowCountForTest()).toBeGreaterThan(0);

      // The in-memory cache holds the same message the store does.
      const cached = (await agentStub.getMessagesForTest()) as ChatMessage[];
      expect((cached[0].parts[0] as { text: string }).text).toBe(largeText);

      ws.close(1000);
    });
  });

  describe("Unicode byte-length measurement", () => {
    it("splits multi-byte Unicode on byte boundaries, not character counts", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      // CJK character \u4e00 is 1 JS char but 3 bytes in UTF-8.
      // 700,000 CJK chars fit a character-count limit but not a byte budget.
      const cjkOutput = "\u4e00".repeat(700_000);

      const message: ChatMessage = {
        id: "unicode-test",
        role: "assistant",
        parts: [
          {
            type: "tool-cjkTool",
            toolCallId: "call_unicode",
            state: "output-available",
            input: {},
            output: cjkOutput
          }
        ] as ChatMessage["parts"]
      };

      await agentStub.persistMessages([message]);

      const stored = (await agentStub.getPersistedMessages()) as ChatMessage[];
      expect(stored.length).toBe(1);
      expect((stored[0].parts[0] as { output: unknown }).output).toBe(
        cjkOutput
      );
      expect(await agentStub.continuationRowCountForTest()).toBeGreaterThan(0);

      ws.close(1000);
    });
  });

  describe("Stream chunk size guard", () => {
    it("normal chunks are stored", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-chunk-ok");
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-delta","delta":"hello"}'
      );
      await agentStub.testFlushChunkBuffer();

      const chunks = await agentStub.getStreamChunks(streamId);
      expect(chunks.length).toBe(1);

      ws.close(1000);
    });

    it("oversized chunks are skipped without crash", async () => {
      const room = crypto.randomUUID();
      const { ws } = await connectChatWS(`/agents/test-chat-agent/${room}`);
      await new Promise((r) => setTimeout(r, 50));

      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const streamId = await agentStub.testStartStream("req-chunk-big");

      // Store a normal chunk first
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-start","id":"t1"}'
      );

      // Store an oversized chunk (>1.8MB) -- should be skipped
      const hugeChunk =
        '{"type":"tool-output-available","output":"' +
        "X".repeat(1_900_000) +
        '"}';
      await agentStub.testStoreStreamChunk(streamId, hugeChunk);

      // Store another normal chunk after
      await agentStub.testStoreStreamChunk(
        streamId,
        '{"type":"text-end","id":"t1"}'
      );

      await agentStub.testFlushChunkBuffer();

      const chunks = await agentStub.getStreamChunks(streamId);
      // Should have 2 chunks (the oversized one was skipped)
      expect(chunks.length).toBe(2);
      expect(chunks[0].body).toContain("text-start");
      expect(chunks[1].body).toContain("text-end");

      ws.close(1000);
    });
  });

  describe("Wake hydration of a split message", () => {
    it("rehydrates a message larger than one row after an eviction", async () => {
      const room = `row-chunk-wake-${crypto.randomUUID()}`;
      const agentStub = await getAgentByName(env.TestChatAgent, room);

      const url = `data:image/png;base64,${btoa("o".repeat(2 * 1024 * 1024))}`;
      await agentStub.persistMessages([
        {
          id: "wake-user",
          role: "user",
          parts: [
            { type: "text", text: "look at this" },
            { type: "file", mediaType: "image/png", url }
          ]
        },
        {
          id: "wake-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "seen" }]
        }
      ]);
      expect(await agentStub.continuationRowCountForTest()).toBeGreaterThan(0);

      await evictDurableObject(agentStub);

      const restored = (await agentStub.getMessagesForTest()) as ChatMessage[];
      expect(restored.map((message) => message.id)).toEqual([
        "wake-user",
        "wake-assistant"
      ]);
      expect(restored[0].parts[1]).toMatchObject({ type: "file", url });

      const response = await exports.default.fetch(
        `http://example.com/agents/test-chat-agent/${room}/get-messages`
      );
      expect((await response.json()) as ChatMessage[]).toEqual(restored);

      await agentStub.clearSessionForTest();
      expect(await agentStub.continuationRowCountForTest()).toBe(0);
    });
  });
});
