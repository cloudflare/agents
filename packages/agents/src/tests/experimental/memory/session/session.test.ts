import { describe, expect, it } from "vitest";
import { Session } from "../../../../experimental/memory/session/session";
import {
  ContextBlocks,
  type ContextProvider
} from "../../../../experimental/memory/session/context";
import type {
  SessionProvider,
  SearchResult,
  StoredCompaction
} from "../../../../experimental/memory/session/provider";
import {
  COMPACTION_PREFIX,
  type CompactResult
} from "../../../../experimental/memory/utils/compaction-helpers";

// ── Test helpers ────────────────────────────────────────────────

type ToolExecuteFn = {
  execute: (args: {
    label: string;
    content: string;
    action?: string;
  }) => Promise<string>;
};

// ── In-memory block provider for pure unit tests ────────────────

class MemoryBlockProvider implements ContextProvider {
  private value: string | null;
  constructor(initial: string | null = null) {
    this.value = initial;
  }
  async get() {
    return this.value;
  }
  async set(content: string) {
    this.value = content;
  }
}

// ── Pure unit tests (no DO needed) ──────────────────────────────

describe("ContextBlocks — frozen system prompt", () => {
  it("toSystemPrompt returns same value on repeated calls", async () => {
    const blocks = new ContextBlocks([
      { label: "soul", initialContent: "You are helpful.", readonly: true },
      {
        label: "memory",
        description: "Facts",
        maxTokens: 1100,
        provider: new MemoryBlockProvider("likes TypeScript")
      }
    ]);
    await blocks.load();

    const p1 = blocks.toSystemPrompt();
    const p2 = blocks.toSystemPrompt();

    expect(p1).toBe(p2);
    expect(p1).toContain("SOUL");
    expect(p1).toContain("You are helpful.");
    expect(p1).toContain("MEMORY");
    expect(p1).toContain("likes TypeScript");
  });

  it("setBlock does NOT change frozen prompt", async () => {
    const provider = new MemoryBlockProvider("original");
    const blocks = new ContextBlocks([
      { label: "memory", maxTokens: 1100, provider }
    ]);
    await blocks.load();

    const frozen = blocks.toSystemPrompt();
    expect(frozen).toContain("original");

    await blocks.setBlock("memory", "updated");

    // Provider updated
    expect(await provider.get()).toBe("updated");
    // Prompt still frozen
    expect(blocks.toSystemPrompt()).toBe(frozen);
    expect(blocks.toSystemPrompt()).toContain("original");
  });

  it("refreshSnapshot picks up changes", async () => {
    const blocks = new ContextBlocks([
      {
        label: "memory",
        maxTokens: 1100,
        provider: new MemoryBlockProvider("v1")
      }
    ]);
    await blocks.load();

    const v1 = blocks.toSystemPrompt();
    await blocks.setBlock("memory", "v2");

    // Still frozen
    expect(blocks.toSystemPrompt()).toBe(v1);

    // Refresh
    const v2 = blocks.refreshSnapshot();
    expect(v2).toContain("v2");
    expect(v2).not.toContain("v1");
    expect(blocks.toSystemPrompt()).toBe(v2);
  });

  it("readonly blocks reject writes", async () => {
    const blocks = new ContextBlocks([
      { label: "soul", initialContent: "identity", readonly: true }
    ]);
    await blocks.load();
    await expect(blocks.setBlock("soul", "hacked")).rejects.toThrow("readonly");
  });

  it("maxTokens enforcement", async () => {
    const blocks = new ContextBlocks([
      { label: "memory", maxTokens: 10, provider: new MemoryBlockProvider("") }
    ]);
    await blocks.load();
    const long = "word ".repeat(50);
    await expect(blocks.setBlock("memory", long)).rejects.toThrow(
      "exceeds maxTokens"
    );
  });

  it("uses plain text format, not XML", async () => {
    const blocks = new ContextBlocks([
      { label: "soul", initialContent: "helpful", readonly: true },
      {
        label: "memory",
        description: "Facts",
        maxTokens: 500,
        provider: new MemoryBlockProvider("coffee")
      }
    ]);
    await blocks.load();
    const prompt = blocks.toSystemPrompt();

    expect(prompt).toContain("═");
    expect(prompt).toContain("SOUL");
    expect(prompt).toContain("MEMORY");
    expect(prompt).not.toContain("<context_block");
  });
});

const stubProvider: SessionProvider = {
  getMessage: () => null,
  getHistory: () => [],
  getLatestLeaf: () => null,
  getBranches: () => [],
  getPathLength: () => 0,
  appendMessage: () => {},
  updateMessage: () => {},
  deleteMessages: () => {},
  clearMessages: () => {},
  addCompaction: () => ({
    id: "",
    summary: "",
    fromMessageId: "",
    toMessageId: "",
    createdAt: ""
  }),
  getCompactions: () => []
};

describe("Session — tools() without load", () => {
  it("tools() returns tool schema with loaded blocks", async () => {
    const session = new Session(stubProvider, {
      context: [
        { label: "soul", initialContent: "identity", readonly: true },
        {
          label: "memory",
          description: "Learned facts",
          maxTokens: 1100,
          provider: new MemoryBlockProvider("")
        },
        {
          label: "todos",
          description: "Task list",
          maxTokens: 2000,
          provider: new MemoryBlockProvider("")
        }
      ]
    });

    const tools = await session.tools();
    expect(tools).toHaveProperty("update_context");
    const tool = tools.update_context as { description: string };

    // Lists writable blocks, not readonly
    expect(tool.description).toContain("memory");
    expect(tool.description).toContain("todos");
    expect(tool.description).not.toContain("soul");
  });

  it("tools() execute lazily loads and writes to provider", async () => {
    const memProvider = new MemoryBlockProvider("");
    const session = new Session(stubProvider, {
      context: [
        {
          label: "memory",
          description: "Facts",
          maxTokens: 1100,
          provider: memProvider
        }
      ]
    });

    const tool = (await session.tools())
      .update_context as unknown as ToolExecuteFn;

    const result = await tool.execute({
      label: "memory",
      content: "user likes coffee"
    });
    expect(result).toContain("Written to memory");
    expect(result).toContain("tokens");
    expect(await memProvider.get()).toBe("user likes coffee");
  });

  it("tools() execute append works", async () => {
    const memProvider = new MemoryBlockProvider("fact1");
    const session = new Session(stubProvider, {
      context: [
        {
          label: "memory",
          description: "Facts",
          maxTokens: 1100,
          provider: memProvider
        }
      ]
    });

    const tool = (await session.tools())
      .update_context as unknown as ToolExecuteFn;
    const result = await tool.execute({
      label: "memory",
      content: "\nfact2",
      action: "append"
    });
    expect(result).toContain("Written to memory");
    expect(await memProvider.get()).toBe("fact1\nfact2");
  });

  it("tools() execute rejects readonly blocks gracefully", async () => {
    const session = new Session(stubProvider, {
      context: [
        { label: "soul", initialContent: "identity", readonly: true },
        {
          label: "memory",
          description: "Facts",
          maxTokens: 1100,
          provider: new MemoryBlockProvider("")
        }
      ]
    });

    const tool = (await session.tools())
      .update_context as unknown as ToolExecuteFn;
    const result = await tool.execute({ label: "soul", content: "hacked" });
    expect(result).toContain("Error");
    expect(result).toContain("readonly");
  });

  it("tools() returns empty when no writable blocks", async () => {
    const session = new Session(stubProvider, {
      context: [{ label: "soul", initialContent: "identity", readonly: true }]
    });
    expect(Object.keys(await session.tools())).toHaveLength(0);
  });
});

// ── Session.create() builder tests ──────────────────────────────

// Minimal SqlProvider stub that records SQL calls
function createSqlStub() {
  const calls: string[] = [];
  const data = new Map<string, string>();

  const sql = <T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] => {
    const query = strings.join("?");
    calls.push(query);

    // Handle CREATE TABLE
    if (
      query.includes("CREATE TABLE") ||
      query.includes("CREATE VIRTUAL TABLE") ||
      query.includes("CREATE INDEX")
    ) {
      return [] as T[];
    }

    // Handle context block get
    if (query.includes("SELECT content FROM cf_agents_context_blocks")) {
      const label = values[0] as string;
      const content = data.get(label);
      if (content) return [{ content }] as T[];
      return [] as T[];
    }

    // Handle context block set
    if (query.includes("INSERT INTO cf_agents_context_blocks")) {
      const label = values[0] as string;
      const content = values[1] as string;
      data.set(label, content);
      return [] as T[];
    }

    return [] as T[];
  };

  return { sql, calls, data };
}

describe("Session.create() builder", () => {
  it("Session.create returns a Session", () => {
    const { sql } = createSqlStub();
    const session = Session.create({ sql });
    expect(session).toBeInstanceOf(Session);
  });

  it("minimal create works", async () => {
    const { sql } = createSqlStub();
    const session = Session.create({ sql });
    // Should be usable immediately — no .build() needed
    expect(session.getHistory()).toEqual([]);
  });

  it("withContext adds writable blocks with auto-created provider", async () => {
    const { sql, data } = createSqlStub();
    const session = Session.create({ sql }).withContext("memory", {
      description: "Facts",
      maxTokens: 1100
    });

    const tools = await session.tools();
    expect(tools).toHaveProperty("update_context");

    // Execute the tool — it should write through to the auto-created provider
    const tool = tools.update_context as unknown as ToolExecuteFn;
    await tool.execute({ label: "memory", content: "test fact" });
    expect(data.get("memory")).toBe("test fact");
  });

  it("withContext readonly blocks do not get auto provider", async () => {
    const { sql } = createSqlStub();
    const session = Session.create({ sql }).withContext("soul", {
      initialContent: "You are helpful.",
      readonly: true
    });

    // No writable blocks → empty tools
    const tools = await session.tools();
    expect(Object.keys(tools)).toHaveLength(0);

    // But the prompt should include the soul block
    const prompt = await session.freezeSystemPrompt();
    expect(prompt).toContain("SOUL");
    expect(prompt).toContain("You are helpful.");
  });

  it("withCachedPrompt auto-creates prompt store", async () => {
    const { sql, data } = createSqlStub();
    const session = Session.create({ sql })
      .withContext("soul", { initialContent: "Be kind.", readonly: true })
      .withCachedPrompt();

    const prompt = await session.freezeSystemPrompt();
    expect(prompt).toContain("Be kind.");

    // Should have persisted to the auto-created store
    expect(data.get("_system_prompt")).toBe(prompt);

    // Second call returns same value (frozen)
    const prompt2 = await session.freezeSystemPrompt();
    expect(prompt2).toBe(prompt);
  });

  it("forSession namespaces provider keys", async () => {
    const { sql, data } = createSqlStub();
    const session = Session.create({ sql })
      .forSession("chat-123")
      .withContext("memory", { maxTokens: 1100 })
      .withCachedPrompt();

    // Write via tool
    const tools = await session.tools();
    const tool = tools.update_context as unknown as ToolExecuteFn;
    await tool.execute({ label: "memory", content: "namespaced fact" });

    // Key should be namespaced
    expect(data.get("memory_chat-123")).toBe("namespaced fact");
    expect(data.has("memory")).toBe(false);

    // Prompt store should also be namespaced
    await session.freezeSystemPrompt();
    expect(data.has("_system_prompt_chat-123")).toBe(true);
    expect(data.has("_system_prompt")).toBe(false);
  });

  it("withContext accepts explicit provider", async () => {
    const customProvider = new MemoryBlockProvider("custom data");
    const { sql } = createSqlStub();
    const session = Session.create({ sql }).withContext("memory", {
      maxTokens: 1100,
      provider: customProvider
    });

    const prompt = await session.freezeSystemPrompt();
    expect(prompt).toContain("custom data");
  });

  it("initialContent seeds writable block on first load", async () => {
    const { sql, data } = createSqlStub();
    const session = Session.create({ sql }).withContext("notes", {
      initialContent: "default notes",
      maxTokens: 500
    });

    // Block should start with initialContent since provider returns null
    const prompt = await session.freezeSystemPrompt();
    expect(prompt).toContain("default notes");

    // But it's writable — tool should work
    const tools = await session.tools();
    const tool = tools.update_context as unknown as ToolExecuteFn;
    await tool.execute({ label: "notes", content: "updated notes" });
    expect(data.get("notes")).toBe("updated notes");
  });

  it("readonly provider with get-only rejects writes", async () => {
    const { sql } = createSqlStub();
    const session = Session.create({ sql }).withContext("config", {
      readonly: true,
      provider: {
        get: async () => "loaded from external"
      }
    });

    // Should load from provider
    const prompt = await session.freezeSystemPrompt();
    expect(prompt).toContain("loaded from external");

    // No writable blocks → empty tools
    const tools = await session.tools();
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it("initialContent + provider — provider wins, initialContent is fallback", async () => {
    const { sql } = createSqlStub();

    // Provider returns data → initialContent ignored
    const session1 = Session.create({ sql }).withContext("memory", {
      initialContent: "seed value",
      provider: new MemoryBlockProvider("from provider")
    });
    const prompt1 = await session1.freezeSystemPrompt();
    expect(prompt1).toContain("from provider");
    expect(prompt1).not.toContain("seed value");

    // Provider returns null → initialContent used
    const session2 = Session.create({ sql }).withContext("memory", {
      initialContent: "seed value",
      provider: new MemoryBlockProvider(null)
    });
    const prompt2 = await session2.freezeSystemPrompt();
    expect(prompt2).toContain("seed value");
  });

  it("forSession before withContext namespaces correctly", async () => {
    const { sql, data } = createSqlStub();

    const session = Session.create({ sql })
      .forSession("abc")
      .withContext("memory", { maxTokens: 500 })
      .withCachedPrompt();

    const tools = await session.tools();
    const tool = tools.update_context as unknown as ToolExecuteFn;
    await tool.execute({ label: "memory", content: "test" });
    expect(data.get("memory_abc")).toBe("test");
  });

  it("withContext before forSession still namespaces correctly", async () => {
    const { sql, data } = createSqlStub();

    // withContext BEFORE forSession — providers resolved lazily, so order doesn't matter
    const session = Session.create({ sql })
      .withContext("memory", { maxTokens: 500 })
      .withCachedPrompt()
      .forSession("xyz");

    const tools = await session.tools();
    const tool = tools.update_context as unknown as ToolExecuteFn;
    await tool.execute({ label: "memory", content: "late namespace" });
    expect(data.get("memory_xyz")).toBe("late namespace");
    expect(data.has("memory")).toBe(false);

    await session.freezeSystemPrompt();
    expect(data.has("_system_prompt_xyz")).toBe(true);
    expect(data.has("_system_prompt")).toBe(false);
  });
});

// ── Edge case tests ──────────────────────────────────────────────

describe("ContextBlocks — edge cases", () => {
  it("freezeSystemPrompt persists empty prompt (all blocks cleared)", async () => {
    const promptStore = new MemoryBlockProvider(null);
    const blocks = new ContextBlocks(
      [
        {
          label: "memory",
          maxTokens: 500,
          provider: new MemoryBlockProvider("")
        }
      ],
      promptStore
    );
    await blocks.load();

    // Memory is empty → prompt is empty string
    const prompt = await blocks.freezeSystemPrompt();

    // Empty prompt should still be persisted (not skipped)
    expect(await promptStore.get()).toBe(prompt);

    // Second call returns the stored value (even though it's empty)
    const prompt2 = await blocks.freezeSystemPrompt();
    expect(prompt2).toBe(prompt);
  });

  it("freezeSystemPrompt distinguishes null (no value) from empty string", async () => {
    const promptStore = new MemoryBlockProvider("");
    const blocks = new ContextBlocks([], promptStore);
    await blocks.load();

    // Store has empty string → should return it (not re-render)
    const prompt = await blocks.freezeSystemPrompt();
    expect(prompt).toBe("");
  });

  it("SearchResult.createdAt is optional", async () => {
    // Verify the type allows omitting createdAt
    const result: SearchResult = {
      id: "m1",
      role: "user",
      content: "test"
    };
    expect(result.createdAt).toBeUndefined();
  });
});

// ── Compaction tests ─────────────────────────────────────────────

function createCompactableSession(
  compactFn: (msgs: UIMessage[]) => Promise<CompactResult | null>
) {
  const messages: UIMessage[] = [];
  const compactions: StoredCompaction[] = [];

  const storage: SessionProvider = {
    getMessage: (id) => messages.find((m) => m.id === id) ?? null,
    getHistory: () => messages,
    getLatestLeaf: () => messages[messages.length - 1] ?? null,
    getBranches: () => [],
    getPathLength: () => messages.length,
    appendMessage: (msg) => messages.push(msg),
    updateMessage: () => {},
    deleteMessages: () => {},
    clearMessages: () => {
      messages.length = 0;
    },
    addCompaction: (summary, from, to) => {
      const c: StoredCompaction = {
        id: crypto.randomUUID(),
        summary,
        fromMessageId: from,
        toMessageId: to,
        createdAt: new Date().toISOString()
      };
      compactions.push(c);
      return c;
    },
    getCompactions: () => compactions
  };

  const session = new Session(storage);
  // Wire compaction function via internal property
  (session as unknown as { _compactionFn: typeof compactFn })._compactionFn =
    compactFn;

  return {
    session,
    messages,
    compactions,
    setTokenThreshold(t: number) {
      (session as unknown as { _tokenThreshold: number })._tokenThreshold = t;
    }
  };
}

describe("Session.compact()", () => {
  it("throws if no compaction function registered", async () => {
    const session = new Session(stubProvider);
    await expect(session.compact()).rejects.toThrow(
      "No compaction function registered"
    );
  });

  it("returns null if fewer than 4 messages", async () => {
    const { session, messages } = createCompactableSession(async () => ({
      fromMessageId: "m1",
      toMessageId: "m2",
      summary: "should not happen"
    }));
    messages.push(
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "hey" }] }
    );

    expect(await session.compact()).toBeNull();
  });

  it("stores compaction overlay from CompactResult", async () => {
    const { session, messages, compactions } = createCompactableSession(
      async (): Promise<CompactResult> => ({
        fromMessageId: "m1",
        toMessageId: "m3",
        summary: "Summary of m1-m3"
      })
    );

    for (let i = 0; i < 6; i++) {
      messages.push({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `msg ${i}` }]
      });
    }

    const result = await session.compact();
    expect(result).not.toBeNull();
    expect(result!.fromMessageId).toBe("m1");
    expect(result!.toMessageId).toBe("m3");
    expect(result!.summary).toBe("Summary of m1-m3");

    expect(compactions).toHaveLength(1);
    expect(compactions[0].summary).toBe("Summary of m1-m3");
    expect(compactions[0].fromMessageId).toBe("m1");
    expect(compactions[0].toMessageId).toBe("m3");
  });

  it("returns null when compaction function returns null", async () => {
    const { session, messages, compactions } = createCompactableSession(
      async () => null
    );

    for (let i = 0; i < 6; i++) {
      messages.push({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `msg ${i}` }]
      });
    }

    expect(await session.compact()).toBeNull();
    expect(compactions).toHaveLength(0);
  });

  it("iterative compaction extends from earliest existing compaction", async () => {
    const { session, messages, compactions } = createCompactableSession(
      async (): Promise<CompactResult> => ({
        fromMessageId: "m6",
        toMessageId: "m8",
        summary: "Round 2"
      })
    );

    for (let i = 0; i < 10; i++) {
      messages.push({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `msg ${i}` }]
      });
    }

    // First compaction already stored
    compactions.push({
      id: "c1",
      summary: "Round 1",
      fromMessageId: "m1",
      toMessageId: "m5",
      createdAt: new Date().toISOString()
    });

    const result = await session.compact();
    expect(result).not.toBeNull();

    expect(compactions).toHaveLength(2);
    const latest = compactions[compactions.length - 1];
    expect(latest.fromMessageId).toBe("m1"); // extended from existing[0]
    expect(latest.toMessageId).toBe("m8");
    expect(latest.summary).toBe("Round 2");
  });

  it("appendMessage auto-compacts when token threshold exceeded", async () => {
    let compactCalled = false;
    const { session, messages, compactions, setTokenThreshold } =
      createCompactableSession(async (): Promise<CompactResult> => {
        compactCalled = true;
        return {
          fromMessageId: "m1",
          toMessageId: "m3",
          summary: "Auto-compacted"
        };
      });

    // Set a very low threshold so it triggers quickly
    setTokenThreshold(10);

    // Seed enough messages so getHistory().length >= 4 (compact minimum)
    for (let i = 0; i < 4; i++) {
      messages.push({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `message ${i} with some content` }]
      });
    }

    // Append one more — should trigger auto-compact (tokens > 10)
    await session.appendMessage({
      id: "m4",
      role: "user",
      parts: [{ type: "text", text: "this should trigger compaction" }]
    });

    expect(compactCalled).toBe(true);
    expect(compactions).toHaveLength(1);
    expect(compactions[0].summary).toBe("Auto-compacted");
  });

  it("appendMessage does not auto-compact below threshold", async () => {
    let compactCalled = false;
    const { session, setTokenThreshold } = createCompactableSession(
      async (): Promise<CompactResult> => {
        compactCalled = true;
        return {
          fromMessageId: "m0",
          toMessageId: "m0",
          summary: "should not happen"
        };
      }
    );

    // Set a very high threshold
    setTokenThreshold(1000000);

    await session.appendMessage({
      id: "m0",
      role: "user",
      parts: [{ type: "text", text: "short" }]
    });

    expect(compactCalled).toBe(false);
  });

  it("appendMessage does not auto-compact without threshold set", async () => {
    let compactCalled = false;
    const { session, messages } = createCompactableSession(
      async (): Promise<CompactResult> => {
        compactCalled = true;
        return {
          fromMessageId: "m0",
          toMessageId: "m3",
          summary: "should not happen"
        };
      }
    );

    // No setTokenThreshold — no auto-compact even with many messages
    for (let i = 0; i < 10; i++) {
      messages.push({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `message ${i}` }]
      });
    }

    await session.appendMessage({
      id: "m10",
      role: "user",
      parts: [{ type: "text", text: "no threshold set" }]
    });

    expect(compactCalled).toBe(false);
  });

  it("appendMessage does not auto-compact without compaction function", async () => {
    const messages: UIMessage[] = [];
    const storage: SessionProvider = {
      getMessage: () => null,
      getHistory: () => messages,
      getLatestLeaf: () => messages[messages.length - 1] ?? null,
      getBranches: () => [],
      getPathLength: () => messages.length,
      appendMessage: (msg) => messages.push(msg),
      updateMessage: () => {},
      deleteMessages: () => {},
      clearMessages: () => {},
      addCompaction: () => ({
        id: "",
        summary: "",
        fromMessageId: "",
        toMessageId: "",
        createdAt: ""
      }),
      getCompactions: () => []
    };

    const session = new Session(storage);
    // Set threshold but no compaction function
    (session as unknown as { _tokenThreshold: number })._tokenThreshold = 10;

    // Should not throw — just skips auto-compact
    await session.appendMessage({
      id: "m0",
      role: "user",
      parts: [{ type: "text", text: "no compaction fn" }]
    });

    expect(messages).toHaveLength(1);
  });

  it("iterative compaction with overlay messages in history", async () => {
    // Simulate getHistory() returning overlay messages from a previous compaction.
    // The compaction function should receive these overlays (filtering is its job),
    // and Session.compact() should store correct real message IDs.
    const messages: UIMessage[] = [];
    const compactions: StoredCompaction[] = [];

    const overlayMsg: UIMessage = {
      id: `${COMPACTION_PREFIX}c1`,
      role: "assistant",
      parts: [{ type: "text", text: "Previous summary" }],
      createdAt: new Date()
    };

    const storage: SessionProvider = {
      getMessage: (id) => messages.find((m) => m.id === id) ?? null,
      getHistory: () => {
        // Simulate applyCompactions: overlay replaces m1-m3, then m4-m7 follow
        return [
          messages[0], // m0 (protected head)
          overlayMsg, // compaction overlay (virtual ID)
          ...messages.slice(4) // m4, m5, m6, m7
        ];
      },
      getLatestLeaf: () => messages[messages.length - 1] ?? null,
      getBranches: () => [],
      getPathLength: () => messages.length,
      appendMessage: (msg) => messages.push(msg),
      updateMessage: () => {},
      deleteMessages: () => {},
      clearMessages: () => {},
      addCompaction: (summary, from, to) => {
        const c: StoredCompaction = {
          id: crypto.randomUUID(),
          summary,
          fromMessageId: from,
          toMessageId: to,
          createdAt: new Date().toISOString()
        };
        compactions.push(c);
        return c;
      },
      getCompactions: () => compactions
    };

    // Seed 8 real messages
    for (let i = 0; i < 8; i++) {
      messages.push({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `message ${i}` }]
      });
    }

    // Pre-existing compaction from first round
    compactions.push({
      id: "c1",
      summary: "Previous summary",
      fromMessageId: "m1",
      toMessageId: "m3",
      createdAt: new Date().toISOString()
    });

    // The compaction function returns real message IDs (m4-m5)
    const session = new Session(storage);
    type Internals = {
      _compactionFn: (m: UIMessage[]) => Promise<CompactResult | null>;
    };
    (session as unknown as Internals)._compactionFn = async (
      msgs
    ): Promise<CompactResult> => {
      // Verify the overlay is passed to the function (it decides what to do with it)
      const hasOverlay = msgs.some((m) => m.id.startsWith(COMPACTION_PREFIX));
      expect(hasOverlay).toBe(true);

      return {
        fromMessageId: "m4",
        toMessageId: "m5",
        summary: "Round 2 summary"
      };
    };

    const result = await session.compact();
    expect(result).not.toBeNull();

    // Session.compact() should extend fromMessageId from the earliest compaction
    expect(compactions).toHaveLength(2);
    const latest = compactions[compactions.length - 1];
    expect(latest.fromMessageId).toBe("m1"); // extended from existing
    expect(latest.toMessageId).toBe("m5"); // real message ID
    expect(latest.summary).toBe("Round 2 summary");

    // Return value should also reflect the extended fromMessageId
    expect(result!.fromMessageId).toBe("m1");
    expect(result!.toMessageId).toBe("m5");
  });

  it("compact broadcasts status to connected clients", async () => {
    const broadcasts: string[] = [];
    const messages: UIMessage[] = [];
    const compactions: StoredCompaction[] = [];

    const storage: SessionProvider = {
      getMessage: () => null,
      getHistory: () => messages,
      getLatestLeaf: () => messages[messages.length - 1] ?? null,
      getBranches: () => [],
      getPathLength: () => messages.length,
      appendMessage: (msg) => messages.push(msg),
      updateMessage: () => {},
      deleteMessages: () => {},
      clearMessages: () => {},
      addCompaction: (summary, from, to) => {
        const c: StoredCompaction = {
          id: "c1",
          summary,
          fromMessageId: from,
          toMessageId: to,
          createdAt: ""
        };
        compactions.push(c);
        return c;
      },
      getCompactions: () => compactions
    };

    const session = new Session(storage);
    // Wire internals
    type Internals = {
      _compactionFn: (m: UIMessage[]) => Promise<CompactResult | null>;
      _broadcaster: { broadcast(msg: string): void };
    };
    const internals = session as unknown as Internals;
    internals._compactionFn = async () => ({
      fromMessageId: "m1",
      toMessageId: "m3",
      summary: "Compacted"
    });
    internals._broadcaster = {
      broadcast: (msg: string) => broadcasts.push(msg)
    };

    for (let i = 0; i < 6; i++) {
      messages.push({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `msg ${i}` }]
      });
    }

    await session.compact();

    // Should have broadcast "compacting" then "idle"
    expect(broadcasts).toHaveLength(2);

    const starting = JSON.parse(broadcasts[0]);
    expect(starting.type).toBe("cf_agent_session");
    expect(starting.phase).toBe("compacting");
    expect(starting.tokenEstimate).toBeGreaterThan(0);

    const complete = JSON.parse(broadcasts[1]);
    expect(complete.type).toBe("cf_agent_session");
    expect(complete.phase).toBe("idle");
    expect(complete.compacted.tokensBefore).toBeGreaterThan(0);
  });
});
