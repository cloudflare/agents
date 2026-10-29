import { describe, expect, it } from "vitest";
import {
  SEARCH_CONTEXT_TOOL,
  SET_CONTEXT_TOOL,
  type WritableContextProvider
} from "../../context";
import { Sessions, type SessionMessage } from "../../sessions";
import {
  withCapabilityHarness,
  type CapabilityHarness
} from "../shared/capability-harness";

/**
 * Context on the session handle: blocks declared with `withContext()`, the
 * frozen prompt stored next to the messages, and the refresh the session
 * runs itself after compaction and clear. Every test runs over real
 * Durable Object SQLite; a second `Sessions` installed on the same storage
 * stands in for the object waking up after an eviction.
 */

/** A context tool's executor, called directly as the model would. */
type ToolFn = { execute: (input: Record<string, unknown>) => Promise<string> };

function text(id: string, body: string, role = "user"): SessionMessage {
  return { id, role, parts: [{ type: "text", text: body }] };
}

function wake(harness: CapabilityHarness): Sessions {
  return harness.install(new Sessions()).capability;
}

function tableNames(storage: DurableObjectStorage): string[] {
  return [
    ...storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    )
  ].map((row) => String(row.name));
}

function storedBlock(
  storage: DurableObjectStorage,
  label: string
): string | null {
  const rows = storage.sql
    .exec<{
      content: string;
    }>("SELECT content FROM cf_agents_context_blocks WHERE label = ?", label)
    .toArray();
  return rows[0]?.content ?? null;
}

describe("Session context", () => {
  it("stores a block without a provider in SQLite, writable and durable", async () => {
    await withCapabilityHarness(async (harness) => {
      const session = wake(harness)
        .session()
        .withContext("memory", { description: "Learned facts" });

      const tools = await session.tools();
      expect(Object.keys(tools)).toEqual([SET_CONTEXT_TOOL]);

      await session.replaceContextBlock("memory", "likes Workers");
      await session.appendContextBlock("memory", "uses SQLite");
      expect(storedBlock(harness.storage, "memory")).toBe(
        "likes Workers\nuses SQLite"
      );

      const woken = wake(harness).session().withContext("memory");
      await woken.context.load();
      expect(woken.getContextBlock("memory")?.content).toBe(
        "likes Workers\nuses SQLite"
      );
    });
  });

  it("stores the frozen prompt by default, so a wake reuses it", async () => {
    await withCapabilityHarness(async (harness) => {
      const declare = (sessions: Sessions) =>
        sessions
          .session()
          .withContext("soul", {
            provider: { get: async () => "You are helpful." }
          })
          .withContext("memory");

      const session = declare(wake(harness));
      const frozen = await session.freezeSystemPrompt();
      expect(frozen).toContain("You are helpful.");
      expect(storedBlock(harness.storage, "_system_prompt")).toBe(frozen);

      // A write after freezing leaves the prompt, and the cached prefix,
      // alone: in this object and in the next one.
      await session.replaceContextBlock("memory", "new fact");
      expect(await session.freezeSystemPrompt()).toBe(frozen);
      const woken = declare(wake(harness));
      expect(await woken.freezeSystemPrompt()).toBe(frozen);

      const refreshed = await woken.refreshSystemPrompt();
      expect(refreshed).toContain("new fact");
      expect(await declare(wake(harness)).freezeSystemPrompt()).toBe(refreshed);
    });
  });

  it("stores the prompt in a custom store from withCachedPrompt()", async () => {
    await withCapabilityHarness(async (harness) => {
      let stored: string | null = null;
      const store: WritableContextProvider = {
        get: async () => stored,
        set: async (content) => {
          stored = content;
        }
      };
      const session = wake(harness)
        .session()
        .withContext("soul", { provider: { get: async () => "Be brief." } })
        .withCachedPrompt(store);

      const frozen = await session.freezeSystemPrompt();
      expect(stored).toBe(frozen);
      expect(tableNames(harness.storage)).not.toContain(
        "cf_agents_context_blocks"
      );
    });
  });

  it("refreshes the prompt after compaction", async () => {
    await withCapabilityHarness(async (harness) => {
      const session = wake(harness)
        .session()
        .withContext("memory")
        .onCompaction(async (messages) => ({
          fromMessageId: messages[0].id,
          toMessageId: messages[1].id,
          summary: "earlier turns"
        }));
      await session.appendMessage(text("m1", "hello"));
      await session.appendMessage(text("m2", "hi", "assistant"));
      await session.appendMessage(text("m3", "more"));

      await session.freezeSystemPrompt();
      await session.replaceContextBlock("memory", "learned before compaction");
      expect(await session.freezeSystemPrompt()).not.toContain(
        "learned before compaction"
      );

      expect(await session.compact()).not.toBeNull();
      expect(await session.freezeSystemPrompt()).toContain(
        "learned before compaction"
      );
    });
  });

  it("refreshes the prompt after clearMessages()", async () => {
    await withCapabilityHarness(async (harness) => {
      const session = wake(harness).session().withContext("memory");
      await session.appendMessage(text("m1", "hello"));
      await session.freezeSystemPrompt();
      await session.replaceContextBlock("memory", "kept across clear");

      await session.clearMessages();
      expect(await session.freezeSystemPrompt()).toContain("kept across clear");
    });
  });

  it("leaves context storage alone in a session that never used it", async () => {
    await withCapabilityHarness(async (harness) => {
      const session = wake(harness)
        .session()
        .onCompaction(async (messages) => ({
          fromMessageId: messages[0].id,
          toMessageId: messages[0].id,
          summary: "summary"
        }));
      await session.appendMessage(text("m1", "hello"));
      await session.appendMessage(text("m2", "again"));
      await session.compact();
      await session.clearMessages();

      expect(tableNames(harness.storage)).not.toContain(
        "cf_agents_context_blocks"
      );
    });
  });

  it("keeps each session's blocks and prompt separate", async () => {
    await withCapabilityHarness(async (harness) => {
      const sessions = wake(harness);
      const left = sessions.session("left").withContext("memory");
      const right = sessions.session("right").withContext("memory");

      await left.replaceContextBlock("memory", "left fact");
      await right.replaceContextBlock("memory", "right fact");
      expect(await left.freezeSystemPrompt()).toContain("left fact");
      expect(await right.freezeSystemPrompt()).toContain("right fact");

      expect(storedBlock(harness.storage, "memory_left")).toBe("left fact");
      expect(storedBlock(harness.storage, "memory_right")).toBe("right fact");
      expect(storedBlock(harness.storage, "_system_prompt_left")).toContain(
        "left fact"
      );
    });
  });

  it("backs a searchable block with a full-text index per session", async () => {
    await withCapabilityHarness(async (harness) => {
      const sessions = wake(harness);
      const left = sessions
        .session("left")
        .withContext("notes", { searchable: true });
      const right = sessions
        .session("right")
        .withContext("notes", { searchable: true });

      const tools = await left.tools();
      expect(Object.keys(tools).sort()).toEqual(
        [SEARCH_CONTEXT_TOOL, SET_CONTEXT_TOOL].sort()
      );
      await (tools[SET_CONTEXT_TOOL] as unknown as ToolFn).execute({
        label: "notes",
        content: "Durable Objects keep SQLite next to compute",
        metadata: { title: "storage" }
      });

      const search = (session: typeof left) =>
        session.tools().then((set) =>
          (set[SEARCH_CONTEXT_TOOL] as unknown as ToolFn).execute({
            label: "notes",
            query: "SQLite"
          })
        );
      expect(await search(left)).toContain("Durable Objects keep SQLite");
      expect(await search(right)).toBe("No results found.");
      expect(await left.freezeSystemPrompt()).toContain("1 entries indexed.");
    });
  });

  it("rejects a block that is both searchable and has a provider", async () => {
    await withCapabilityHarness(async (harness) => {
      const session = wake(harness)
        .session()
        .withContext("notes", {
          searchable: true,
          provider: { get: async () => null }
        });
      expect(() => session.context).toThrow(/searchable and provider/);
    });
  });

  it("ignores an identical redeclaration and rejects a conflicting one", async () => {
    await withCapabilityHarness(async (harness) => {
      const provider = { get: async () => "soul" };
      const session = wake(harness)
        .session()
        .withContext("soul", { provider })
        .withContext("soul", { provider });

      expect(() =>
        session.withContext("soul", { provider: { get: async () => "x" } })
      ).toThrow(/different options/);

      await session.freezeSystemPrompt();
      expect(session.getContextBlocks().map((block) => block.label)).toEqual([
        "soul"
      ]);
    });
  });

  it("closes declarations once the context is in use; addContext() adds later", async () => {
    await withCapabilityHarness(async (harness) => {
      const session = wake(harness).session().withContext("memory");
      await session.freezeSystemPrompt();

      expect(() => session.withContext("late")).toThrow(/addContext/);

      await session.addContext("late", {
        provider: { get: async () => "added later" }
      });
      expect(await session.freezeSystemPrompt()).not.toContain("added later");
      expect(await session.refreshSystemPrompt()).toContain("added later");

      expect(session.removeContext("late")).toBe(true);
      expect(await session.refreshSystemPrompt()).not.toContain("added later");
    });
  });

  it("reports remind blocks that changed after freezing", async () => {
    await withCapabilityHarness(async (harness) => {
      let date = "2026-01-01";
      const session = wake(harness)
        .session()
        .withContext("environment", {
          provider: { get: async () => `Today is ${date}.` },
          whenChanged: "remind"
        });

      await session.freezeSystemPrompt();
      expect(await session.contextReminder()).toBeNull();
      date = "2026-01-02";
      expect(await session.contextReminder()).toContain("Today is 2026-01-02.");
    });
  });
});
