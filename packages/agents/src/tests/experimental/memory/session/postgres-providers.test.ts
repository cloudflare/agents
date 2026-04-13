import { describe, expect, it, beforeEach } from "vitest";
import {
  PostgresSessionProvider,
  type PostgresConnection
} from "../../../../experimental/memory/session/providers/postgres";
import { PostgresContextProvider } from "../../../../experimental/memory/session/providers/postgres-context";
import { PostgresSearchProvider } from "../../../../experimental/memory/session/providers/postgres-search";
import type { SessionMessage } from "../../../../experimental/memory/session/types";
import { ContextBlocks } from "../../../../experimental/memory/session/context";
import { convertToModelMessages, type UIMessage } from "ai";

// ── In-memory Postgres mock ─────────────────────────────────────

type Row = Record<string, unknown>;

class InMemoryPostgres implements PostgresConnection {
  private tables = new Map<string, Row[]>();

  async execute(
    query: string,
    args?: (string | number | boolean | null)[]
  ): Promise<{ rows: Row[] }> {
    // Convert ? placeholders to indexed for matching
    let idx = 0;
    const params = args ?? [];
    const q = query.replace(/\?/g, () => `$${++idx}`).trim();

    // Route to handler based on query
    if (q.startsWith("INSERT INTO")) return this.handleInsert(q, params);
    if (q.startsWith("UPDATE")) return this.handleUpdate(q, params);
    if (q.startsWith("DELETE FROM")) return this.handleDelete(q, params);
    if (q.startsWith("SELECT") || q.startsWith("WITH")) return this.handleSelect(q, params);
    return { rows: [] };
  }

  private getTable(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  private handleInsert(q: string, params: unknown[]): { rows: Row[] } {
    const tableMatch = q.match(/INSERT INTO (\w+)/);
    if (!tableMatch) return { rows: [] };
    const table = this.getTable(tableMatch[1]);

    const colsMatch = q.match(/\(([^)]+)\)\s*VALUES/);
    if (!colsMatch) return { rows: [] };
    const cols = colsMatch[1].split(",").map((c) => c.trim());

    const row: Row = {};
    cols.forEach((col, i) => {
      row[col] = params[i] ?? null;
    });
    row.created_at = new Date().toISOString();
    row.updated_at = new Date().toISOString();

    // Handle ON CONFLICT DO NOTHING
    if (q.includes("ON CONFLICT") && q.includes("DO NOTHING")) {
      const pk = cols[0];
      if (table.some((r) => r[pk] === row[pk])) return { rows: [] };
    }

    // Handle ON CONFLICT DO UPDATE
    if (q.includes("ON CONFLICT") && q.includes("DO UPDATE")) {
      const existing = table.find((r) => {
        // Check composite key (label, key) or single key
        if (cols.includes("label") && cols.includes("key")) {
          return r.label === row.label && r.key === row.key;
        }
        if (cols.includes("label")) {
          return r.label === row.label;
        }
        return r[cols[0]] === row[cols[0]];
      });
      if (existing) {
        existing.content = row.content;
        existing.updated_at = new Date().toISOString();
        return { rows: [] };
      }
    }

    table.push(row);
    return { rows: [] };
  }

  private handleUpdate(q: string, params: unknown[]): { rows: Row[] } {
    const tableMatch = q.match(/UPDATE (\w+)/);
    if (!tableMatch) return { rows: [] };
    const table = this.getTable(tableMatch[1]);

    // Simple: UPDATE table SET content = $1 WHERE id = $2 AND session_id = $3
    const row = table.find(
      (r) => r.id === params[1] && r.session_id === params[2]
    );
    if (row) row.content = params[0];
    return { rows: [] };
  }

  private handleDelete(q: string, params: unknown[]): { rows: Row[] } {
    const tableMatch = q.match(/DELETE FROM (\w+)/);
    if (!tableMatch) return { rows: [] };
    const tableName = tableMatch[1];
    const table = this.getTable(tableName);

    if (q.includes("WHERE id = ") || (q.includes("id = ") && q.includes("AND session_id = "))) {
      this.tables.set(
        tableName,
        table.filter(
          (r) => !(r.id === params[0] && r.session_id === params[1])
        )
      );
    } else if (q.includes("session_id = ")) {
      this.tables.set(
        tableName,
        table.filter((r) => r.session_id !== params[0])
      );
    }
    return { rows: [] };
  }

  private handleSelect(q: string, params: unknown[]): { rows: Row[] } {
    // Handle WITH RECURSIVE for getHistory
    if (q.includes("WITH RECURSIVE")) {
      return this.handleRecursiveSelect(q, params);
    }

    // Handle COUNT(*)
    if (q.includes("COUNT(*)")) {
      const tableMatch = q.match(/FROM (\w+)/);
      if (!tableMatch) return { rows: [{ count: 0 }] };
      const table = this.getTable(tableMatch[1]);
      const filtered = this.filterByParams(table, q, params);
      return { rows: [{ count: filtered.length }] };
    }

    // Handle regular SELECT
    const tableMatch = q.match(/FROM (\w+)\s+(\w+)?/);
    if (!tableMatch) return { rows: [] };
    let tableName = tableMatch[1];
    // Handle alias: FROM table alias
    if (tableName === "cf_agents_context_blocks" || tableName === "cf_agents_search_entries" || tableName === "assistant_messages" || tableName === "assistant_compactions") {
      // good
    } else {
      return { rows: [] };
    }

    const table = this.getTable(tableName);
    const filtered = this.filterByParams(table, q, params);

    // Handle LIMIT
    const limitMatch = q.match(/LIMIT \$(\d+)/);
    if (limitMatch) {
      const limit = Number(params[Number(limitMatch[1]) - 1]);
      return { rows: filtered.slice(0, limit) };
    }

    return { rows: filtered };
  }

  private handleRecursiveSelect(q: string, params: unknown[]): { rows: Row[] } {
    const table = this.getTable("assistant_messages");
    const startId = params[0] as string;

    // Walk parent chain
    const path: Row[] = [];
    let current = table.find((r) => r.id === startId);
    while (current) {
      path.unshift(current);
      current = current.parent_id
        ? table.find((r) => r.id === current!.parent_id)
        : undefined;
    }

    if (q.includes("COUNT(*)")) {
      return { rows: [{ count: path.length }] };
    }
    return { rows: path };
  }

  private filterByParams(table: Row[], q: string, params: unknown[]): Row[] {
    let result = [...table];

    // Filter by session_id
    const sessionMatch = q.match(/session_id = \$(\d+)/);
    if (sessionMatch) {
      const val = params[Number(sessionMatch[1]) - 1];
      result = result.filter((r) => r.session_id === val);
    }

    // Filter by id
    const idMatch = q.match(/(?:WHERE|AND)\s+id = \$(\d+)/);
    if (idMatch) {
      const val = params[Number(idMatch[1]) - 1];
      result = result.filter((r) => r.id === val);
    }

    // Filter by parent_id
    const parentMatch = q.match(/parent_id = \$(\d+)/);
    if (parentMatch) {
      const val = params[Number(parentMatch[1]) - 1];
      result = result.filter((r) => r.parent_id === val);
    }

    // Filter by label
    const labelMatch = q.match(/(?:WHERE|AND)\s+label = \$(\d+)/);
    if (labelMatch) {
      const val = params[Number(labelMatch[1]) - 1];
      result = result.filter((r) => r.label === val);
    }

    // Handle ILIKE
    if (q.includes("ILIKE")) {
      const ilikeMatch = q.match(/ILIKE \$(\d+)/);
      if (ilikeMatch) {
        const pattern = (params[Number(ilikeMatch[1]) - 1] as string)
          .replace(/%/g, "")
          .toLowerCase();
        result = result.filter((r) =>
          (r.content as string).toLowerCase().includes(pattern)
        );
      }
    }

    // Handle tsvector search (simplified: treat as ILIKE)
    if (q.includes("plainto_tsquery")) {
      const tsMatch = q.match(/plainto_tsquery\('english', \$(\d+)\)/);
      if (tsMatch) {
        const terms = (params[Number(tsMatch[1]) - 1] as string)
          .toLowerCase()
          .split(/\s+/);
        result = result.filter((r) =>
          terms.some((t) =>
            (r.content as string).toLowerCase().includes(t)
          )
        );
      }
    }

    // Handle LEFT JOIN for latest leaf
    if (q.includes("LEFT JOIN") && q.includes("c.id IS NULL")) {
      const allIds = new Set(table.map((r) => r.id));
      const childParentIds = new Set(table.map((r) => r.parent_id).filter(Boolean));
      result = result.filter(
        (r) => !childParentIds.has(r.id as string) || !allIds.has(r.id as string)
      );
      // Actually: leaf = no children pointing to it
      const parentIds = new Set(table.filter(r => r.parent_id).map(r => r.parent_id));
      result = table.filter(
        (r) => !parentIds.has(r.id as string)
      );
      // Apply session filter
      if (sessionMatch) {
        const val = params[Number(sessionMatch[1]) - 1];
        result = result.filter((r) => r.session_id === val);
      }
    }

    // Sort by created_at DESC if ORDER BY ... DESC
    if (q.includes("ORDER BY") && q.includes("DESC")) {
      result.sort(
        (a, b) =>
          new Date(b.created_at as string).getTime() -
          new Date(a.created_at as string).getTime()
      );
    }

    return result;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function makeMessage(
  id: string,
  role: string,
  text: string
): SessionMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

// ── Tests ───────────────────────────────────────────────────────

describe("PostgresSessionProvider", () => {
  let conn: InMemoryPostgres;
  let provider: PostgresSessionProvider;

  beforeEach(() => {
    conn = new InMemoryPostgres();
    provider = new PostgresSessionProvider(conn, "test-session");
  });

  it("returns empty history for new session", async () => {
    const history = await provider.getHistory();
    expect(history).toEqual([]);
  });

  it("appends and retrieves a message", async () => {
    const msg = makeMessage("m1", "user", "hello");
    await provider.appendMessage(msg);

    const retrieved = await provider.getMessage("m1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("m1");
    expect(retrieved!.parts[0].text).toBe("hello");
  });

  it("builds history chain via parent_id", async () => {
    await provider.appendMessage(makeMessage("m1", "user", "first"));
    await provider.appendMessage(makeMessage("m2", "assistant", "second"));
    await provider.appendMessage(makeMessage("m3", "user", "third"));

    const history = await provider.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0].id).toBe("m1");
    expect(history[1].id).toBe("m2");
    expect(history[2].id).toBe("m3");
  });

  it("appendMessage is idempotent", async () => {
    const msg = makeMessage("m1", "user", "hello");
    await provider.appendMessage(msg);
    await provider.appendMessage(msg);

    const history = await provider.getHistory();
    expect(history).toHaveLength(1);
  });

  it("updates a message", async () => {
    await provider.appendMessage(makeMessage("m1", "user", "original"));
    await provider.updateMessage(makeMessage("m1", "user", "updated"));

    const msg = await provider.getMessage("m1");
    expect(msg!.parts[0].text).toBe("updated");
  });

  it("deletes messages", async () => {
    await provider.appendMessage(makeMessage("m1", "user", "a"));
    await provider.appendMessage(makeMessage("m2", "assistant", "b"));

    await provider.deleteMessages(["m1"]);
    expect(await provider.getMessage("m1")).toBeNull();
    expect(await provider.getMessage("m2")).not.toBeNull();
  });

  it("clears all messages and compactions", async () => {
    await provider.appendMessage(makeMessage("m1", "user", "a"));
    await provider.addCompaction("summary", "m1", "m1");

    await provider.clearMessages();
    expect(await provider.getHistory()).toEqual([]);
    expect(await provider.getCompactions()).toEqual([]);
  });

  it("getLatestLeaf returns the last message", async () => {
    await provider.appendMessage(makeMessage("m1", "user", "a"));
    await provider.appendMessage(makeMessage("m2", "assistant", "b"));

    const leaf = await provider.getLatestLeaf();
    expect(leaf!.id).toBe("m2");
  });

  it("getPathLength counts messages", async () => {
    await provider.appendMessage(makeMessage("m1", "user", "a"));
    await provider.appendMessage(makeMessage("m2", "assistant", "b"));
    await provider.appendMessage(makeMessage("m3", "user", "c"));

    const length = await provider.getPathLength();
    expect(length).toBe(3);
  });

  it("isolates sessions by session_id", async () => {
    const other = new PostgresSessionProvider(conn, "other-session");

    await provider.appendMessage(makeMessage("m1", "user", "session1"));
    await other.appendMessage(makeMessage("m2", "user", "session2"));

    const h1 = await provider.getHistory();
    const h2 = await other.getHistory();
    expect(h1).toHaveLength(1);
    expect(h1[0].parts[0].text).toBe("session1");
    expect(h2).toHaveLength(1);
    expect(h2[0].parts[0].text).toBe("session2");
  });

  it("adds and retrieves compactions", async () => {
    const comp = await provider.addCompaction("summary", "m1", "m5");
    expect(comp.summary).toBe("summary");
    expect(comp.fromMessageId).toBe("m1");
    expect(comp.toMessageId).toBe("m5");

    const all = await provider.getCompactions();
    expect(all).toHaveLength(1);
    expect(all[0].summary).toBe("summary");
  });
});

describe("PostgresContextProvider", () => {
  let conn: InMemoryPostgres;

  beforeEach(() => {
    conn = new InMemoryPostgres();
  });

  it("returns null for unset label", async () => {
    const ctx = new PostgresContextProvider(conn, "memory");
    expect(await ctx.get()).toBeNull();
  });

  it("sets and gets content", async () => {
    const ctx = new PostgresContextProvider(conn, "memory");
    await ctx.set("hello world");
    expect(await ctx.get()).toBe("hello world");
  });

  it("overwrites on second set", async () => {
    const ctx = new PostgresContextProvider(conn, "memory");
    await ctx.set("first");
    await ctx.set("second");
    expect(await ctx.get()).toBe("second");
  });

  it("isolates by label", async () => {
    const a = new PostgresContextProvider(conn, "memory");
    const b = new PostgresContextProvider(conn, "todos");
    await a.set("facts");
    await b.set("tasks");
    expect(await a.get()).toBe("facts");
    expect(await b.get()).toBe("tasks");
  });
});

describe("PostgresSearchProvider", () => {
  let conn: InMemoryPostgres;
  let search: PostgresSearchProvider;

  beforeEach(() => {
    conn = new InMemoryPostgres();
    search = new PostgresSearchProvider(conn);
    search.init("knowledge");
  });

  it("returns null when empty, count when populated", async () => {
    expect(await search.get()).toBeNull();
    await search.set("meeting-notes", "deployment scheduled for Friday");
    expect(await search.get()).toBe("1 entries indexed.");
  });

  it("searches indexed content", async () => {
    await search.set("notes", "the deployment is on Friday with budget concerns");
    await search.set("api-doc", "REST endpoints with JSON responses");

    const result = await search.search("deployment");
    expect(result).toContain("notes");
    expect(result).toContain("deployment");
  });

  it("returns no results for non-matching query", async () => {
    await search.set("notes", "hello world");
    const result = await search.search("nonexistent");
    expect(result).toBe("No results found.");
  });

  it("upserts on duplicate key", async () => {
    await search.set("doc", "original about cats");
    await search.set("doc", "replaced about dogs");

    expect(await search.get()).toBe("1 entries indexed.");

    const result = await search.search("dogs");
    expect(result).toContain("replaced");
  });

  it("isolates by label", async () => {
    const other = new PostgresSearchProvider(conn);
    other.init("other");

    await search.set("key1", "knowledge content");
    await other.set("key2", "other content");

    expect(await search.get()).toBe("1 entries indexed.");
    expect(await other.get()).toBe("1 entries indexed.");
  });
});

describe("Postgres providers with Session + ContextBlocks", () => {
  let conn: InMemoryPostgres;

  beforeEach(() => {
    conn = new InMemoryPostgres();
  });

  it("system prompt includes soul block content", async () => {
    const soulProvider = {
      get: async () => "You are a helpful assistant."
    };

    const blocks = new ContextBlocks([
      { label: "soul", provider: soulProvider }
    ]);

    const prompt = await blocks.freezeSystemPrompt();
    expect(prompt).toContain("You are a helpful assistant.");
    expect(prompt).toContain("SOUL");
  });

  it("system prompt includes memory block from PostgresContextProvider", async () => {
    const memProvider = new PostgresContextProvider(conn, "memory");
    await memProvider.set("User likes coffee.");

    const blocks = new ContextBlocks([
      { label: "soul", provider: { get: async () => "You are helpful." } },
      {
        label: "memory",
        description: "Learned facts",
        maxTokens: 1100,
        provider: memProvider
      }
    ]);

    const prompt = await blocks.freezeSystemPrompt();
    expect(prompt).toContain("SOUL");
    expect(prompt).toContain("You are helpful.");
    expect(prompt).toContain("MEMORY");
    expect(prompt).toContain("User likes coffee.");
  });

  it("system prompt persists via PostgresContextProvider prompt store", async () => {
    const promptStore = new PostgresContextProvider(conn, "_prompt");
    const memProvider = new PostgresContextProvider(conn, "memory");
    await memProvider.set("User likes coffee.");

    const blocks = new ContextBlocks(
      [
        { label: "soul", provider: { get: async () => "You are helpful." } },
        {
          label: "memory",
          description: "Learned facts",
          provider: memProvider
        }
      ],
      promptStore
    );

    // First call renders and stores
    const prompt1 = await blocks.freezeSystemPrompt();
    expect(prompt1).toContain("User likes coffee.");

    // Verify it was persisted
    const stored = await promptStore.get();
    expect(stored).toBe(prompt1);
    expect(stored!.length).toBeGreaterThan(0);

    // Second call returns cached value
    const prompt2 = await blocks.freezeSystemPrompt();
    expect(prompt2).toBe(prompt1);
  });

  it("refreshSystemPrompt re-renders after block update", async () => {
    const promptStore = new PostgresContextProvider(conn, "_prompt");
    const memProvider = new PostgresContextProvider(conn, "memory");
    await memProvider.set("User likes coffee.");

    const blocks = new ContextBlocks(
      [
        {
          label: "memory",
          description: "Facts",
          provider: memProvider
        }
      ],
      promptStore
    );

    const prompt1 = await blocks.freezeSystemPrompt();
    expect(prompt1).toContain("User likes coffee.");

    // Update the block
    await blocks.setBlock("memory", "User likes tea.");
    const prompt2 = await blocks.refreshSystemPrompt();
    expect(prompt2).toContain("User likes tea.");
    expect(prompt2).not.toContain("User likes coffee.");
  });

  it("search provider generates search_context tool", async () => {
    const searchProvider = new PostgresSearchProvider(conn);

    const blocks = new ContextBlocks([
      {
        label: "knowledge",
        description: "Searchable knowledge base",
        provider: searchProvider
      }
    ]);

    const tools = await blocks.tools();
    expect(tools.search_context).toBeDefined();
    expect(tools.set_context).toBeDefined();
  });
});

// ── dynamic-tool round-trip tests ─────────────────────────────

function makeToolMessage(id: string): SessionMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "set_context",
        toolCallId: "call-abc-123",
        state: "output-available",
        input: { action: "set", label: "memory", content: "User likes cats" },
        output: "Saved to memory"
      } as unknown as SessionMessage["parts"][number],
      { type: "text", text: "I saved that to memory." }
    ]
  };
}

describe("dynamic-tool parts round-trip through Postgres", () => {
  let conn: InMemoryPostgres;
  let provider: PostgresSessionProvider;

  beforeEach(() => {
    conn = new InMemoryPostgres();
    provider = new PostgresSessionProvider(conn, "test-session");
  });

  it("preserves dynamic-tool part fields after store+retrieve", async () => {
    const msg = makeToolMessage("a1");
    await provider.appendMessage(msg);

    const retrieved = await provider.getMessage("a1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.parts).toHaveLength(2);

    const toolPart = retrieved!.parts[0] as Record<string, unknown>;
    expect(toolPart.type).toBe("dynamic-tool");
    expect(toolPart.toolName).toBe("set_context");
    expect(toolPart.toolCallId).toBe("call-abc-123");
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.input).toEqual({
      action: "set",
      label: "memory",
      content: "User likes cats"
    });
    expect(toolPart.output).toBe("Saved to memory");

    const textPart = retrieved!.parts[1];
    expect(textPart.type).toBe("text");
    expect(textPart.text).toBe("I saved that to memory.");
  });

  it("preserves dynamic-tool parts in getHistory chain", async () => {
    await provider.appendMessage(makeMessage("u1", "user", "remember I like cats"));
    await provider.appendMessage(makeToolMessage("a1"));
    await provider.appendMessage(makeMessage("u2", "user", "what do I like?"));

    const history = await provider.getHistory();
    expect(history).toHaveLength(3);

    // Check the assistant message in the middle
    const assistantMsg = history[1];
    expect(assistantMsg.id).toBe("a1");
    expect(assistantMsg.parts).toHaveLength(2);

    const toolPart = assistantMsg.parts[0] as Record<string, unknown>;
    expect(toolPart.type).toBe("dynamic-tool");
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("Saved to memory");
  });
});

describe("convertToModelMessages compatibility", () => {
  let conn: InMemoryPostgres;
  let provider: PostgresSessionProvider;

  beforeEach(() => {
    conn = new InMemoryPostgres();
    provider = new PostgresSessionProvider(conn, "test-session");
  });

  it("text-only history converts without error", async () => {
    await provider.appendMessage(makeMessage("u1", "user", "hello"));
    await provider.appendMessage(makeMessage("a1", "assistant", "hi there"));

    const history = await provider.getHistory();
    const modelMessages = await convertToModelMessages(history as UIMessage[]);

    expect(modelMessages).toHaveLength(2);
    expect(modelMessages[0].role).toBe("user");
    expect(modelMessages[1].role).toBe("assistant");
  });

  it("output-available dynamic-tool parts convert without error", async () => {
    await provider.appendMessage(makeMessage("u1", "user", "remember cats"));
    await provider.appendMessage(makeToolMessage("a1"));

    const history = await provider.getHistory();
    const modelMessages = await convertToModelMessages(history as UIMessage[]);

    // Should produce: user msg, assistant msg (with tool-call), tool msg (with tool-result)
    expect(modelMessages.length).toBeGreaterThanOrEqual(2);

    // Find the assistant message
    const assistantModel = modelMessages.find((m) => m.role === "assistant");
    expect(assistantModel).toBeDefined();

    // It should contain a tool-call content part
    const content = assistantModel!.content as Array<{ type: string }>;
    const toolCall = content.find((c) => c.type === "tool-call");
    expect(toolCall).toBeDefined();

    // There should be a tool message with the result
    const toolModel = modelMessages.find((m) => m.role === "tool");
    expect(toolModel).toBeDefined();
  });

  it("input-available dynamic-tool parts produce orphaned tool-calls without ignoreIncompleteToolCalls", async () => {
    const msg: SessionMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "set_context",
          toolCallId: "call-orphan",
          state: "input-available",
          input: { action: "set", label: "memory", content: "test" }
        } as unknown as SessionMessage["parts"][number],
        { type: "text", text: "Let me save that." }
      ]
    };

    await provider.appendMessage(makeMessage("u1", "user", "hello"));
    await provider.appendMessage(msg);
    await provider.appendMessage(makeMessage("u2", "user", "next question"));

    const history = await provider.getHistory();

    // convertToModelMessages does NOT throw — it produces model messages
    // with orphaned tool-calls. The downstream generateText/convertToLanguageModelPrompt
    // is what throws MissingToolResultsError.
    const modelMessages = await convertToModelMessages(history as UIMessage[]);

    // Assistant message has a tool-call but there's no tool message with result
    const assistantModel = modelMessages.find((m) => m.role === "assistant");
    const content = assistantModel!.content as Array<{ type: string }>;
    const toolCall = content.find((c) => c.type === "tool-call");
    expect(toolCall).toBeDefined();

    // No tool message because input-available has no output to generate result from
    const toolModel = modelMessages.find((m) => m.role === "tool");
    expect(toolModel).toBeUndefined();
  });

  it("input-available parts are stripped with ignoreIncompleteToolCalls", async () => {
    const msg: SessionMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "set_context",
          toolCallId: "call-orphan",
          state: "input-available",
          input: { action: "set", label: "memory", content: "test" }
        } as unknown as SessionMessage["parts"][number],
        { type: "text", text: "Let me save that." }
      ]
    };

    await provider.appendMessage(makeMessage("u1", "user", "hello"));
    await provider.appendMessage(msg);
    await provider.appendMessage(makeMessage("u2", "user", "next question"));

    const history = await provider.getHistory();

    // With the flag, incomplete tool calls should be stripped
    const modelMessages = await convertToModelMessages(history as UIMessage[], {
      ignoreIncompleteToolCalls: true
    });

    // Should not throw, and should produce valid messages
    expect(modelMessages.length).toBeGreaterThanOrEqual(3);

    // The assistant message should only have text, no tool-call
    const assistantModel = modelMessages.find((m) => m.role === "assistant");
    expect(assistantModel).toBeDefined();
    const content = assistantModel!.content as Array<{ type: string }>;
    const toolCall = content.find((c) => c.type === "tool-call");
    expect(toolCall).toBeUndefined();
  });

  it("multi-turn with tools converts correctly for second generateText call", async () => {
    // Simulate: user asks -> assistant uses tool -> user asks again
    // This is the exact flow that breaks in production
    await provider.appendMessage(makeMessage("u1", "user", "remember I like cats"));
    await provider.appendMessage(makeToolMessage("a1"));
    await provider.appendMessage(makeMessage("u2", "user", "what do I like?"));

    const history = await provider.getHistory();

    // This is what generateText receives on the second turn
    const modelMessages = await convertToModelMessages(history as UIMessage[]);

    // Should produce: user, assistant (tool-call + text), tool (result), user
    expect(modelMessages.length).toBeGreaterThanOrEqual(4);

    // Verify ordering: the tool result comes before the second user message
    const roles = modelMessages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user"]);
  });

  it("multiple tool calls in one message convert correctly", async () => {
    const msg: SessionMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "set_context",
          toolCallId: "call-1",
          state: "output-available",
          input: { action: "set", label: "memory", content: "fact 1" },
          output: "Saved"
        } as unknown as SessionMessage["parts"][number],
        {
          type: "dynamic-tool",
          toolName: "search_context",
          toolCallId: "call-2",
          state: "output-available",
          input: { label: "knowledge", query: "cats" },
          output: "No results found."
        } as unknown as SessionMessage["parts"][number],
        { type: "text", text: "I checked my knowledge base." }
      ]
    };

    await provider.appendMessage(makeMessage("u1", "user", "search for cats"));
    await provider.appendMessage(msg);

    const history = await provider.getHistory();
    const modelMessages = await convertToModelMessages(history as UIMessage[]);

    // Assistant message should have 2 tool-calls
    const assistantModel = modelMessages.find((m) => m.role === "assistant");
    const content = assistantModel!.content as Array<{ type: string; toolCallId?: string }>;
    const toolCalls = content.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(2);

    // Tool message should have 2 results
    const toolModel = modelMessages.find((m) => m.role === "tool");
    expect(toolModel).toBeDefined();
    const toolContent = toolModel!.content as Array<{ type: string }>;
    const toolResults = toolContent.filter((c) => c.type === "tool-result");
    expect(toolResults).toHaveLength(2);
  });
});
