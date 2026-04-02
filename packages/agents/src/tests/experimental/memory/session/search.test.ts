import { describe, expect, it } from "vitest";
import {
  ContextBlocks,
  type ContextProvider
} from "../../../../experimental/memory/session/context";
import type { SearchProvider } from "../../../../experimental/memory/session/search";

// ── In-memory search provider for tests ────────────────────────

class MemorySearchProvider implements SearchProvider {
  private entries = new Map<string, string>();

  async get(): Promise<string | null> {
    if (this.entries.size === 0) return null;
    const keys = Array.from(this.entries.keys());
    return `${keys.length} entries indexed.\n${keys.map((k) => `- ${k}`).join("\n")}`;
  }

  async search(query: string): Promise<string | null> {
    const results: string[] = [];
    const q = query.toLowerCase();
    for (const [key, content] of this.entries) {
      if (content.toLowerCase().includes(q)) {
        results.push(`[${key}]\n${content}`);
      }
    }
    return results.length > 0 ? results.join("\n\n") : null;
  }

  async set(key: string, content: string): Promise<void> {
    this.entries.set(key, content);
  }
}

class ReadonlySearchProvider implements SearchProvider {
  private entries: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    this.entries = new Map(Object.entries(entries));
  }

  async get(): Promise<string | null> {
    if (this.entries.size === 0) return null;
    return `${this.entries.size} entries indexed.`;
  }

  async search(query: string): Promise<string | null> {
    const results: string[] = [];
    const q = query.toLowerCase();
    for (const [key, content] of this.entries) {
      if (content.toLowerCase().includes(q)) {
        results.push(`[${key}]\n${content}`);
      }
    }
    return results.length > 0 ? results.join("\n\n") : null;
  }
}

class ReadonlyProvider implements ContextProvider {
  constructor(private value: string | null = null) {}
  async get() {
    return this.value;
  }
}

// ── Provider detection ─────────────────────────────────────────

describe("SearchProvider detection", () => {
  it("search provider: search_context tool available", async () => {
    const blocks = new ContextBlocks([
      {
        label: "knowledge",
        provider: new MemorySearchProvider()
      }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    expect(tools).toHaveProperty("search_context");
    expect(tools).toHaveProperty("set_context");
  });

  it("no search_context when no search providers", async () => {
    const blocks = new ContextBlocks([
      { label: "soul", provider: new ReadonlyProvider("identity") }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    expect(tools).not.toHaveProperty("search_context");
  });

  it("readonly search provider: search_context but no set_context", async () => {
    const blocks = new ContextBlocks([
      {
        label: "docs",
        provider: new ReadonlySearchProvider({ readme: "Hello world" })
      }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    expect(tools).toHaveProperty("search_context");
    expect(tools).not.toHaveProperty("set_context");
  });
});

// ── System prompt rendering ────────────────────────────────────

describe("Search blocks in system prompt", () => {
  it("renders searchable hint in header", async () => {
    const blocks = new ContextBlocks([
      {
        label: "knowledge",
        description: "Product docs",
        provider: new ReadonlySearchProvider({ readme: "content" })
      }
    ]);
    await blocks.load();
    const prompt = blocks.toSystemPrompt();
    expect(prompt).toContain("KNOWLEDGE");
    expect(prompt).toContain("search_context");
    expect(prompt).toContain("Product docs");
  });

  it("renders searchable block even when content is empty", async () => {
    const blocks = new ContextBlocks([
      {
        label: "knowledge",
        provider: new MemorySearchProvider()
      }
    ]);
    await blocks.load();
    const prompt = blocks.toSystemPrompt();
    // Empty search provider returns null → content is ""
    // But isSearchable means it still renders
    expect(prompt).toContain("KNOWLEDGE");
    expect(prompt).toContain("search_context");
  });
});

// ── search_context tool ────────────────────────────────────────

type SearchToolFn = {
  execute: (args: { label: string; query: string }) => Promise<string>;
};

describe("search_context tool", () => {
  it("returns matching results", async () => {
    const provider = new ReadonlySearchProvider({
      "meeting-notes": "We discussed the deployment timeline",
      "design-doc": "The API uses REST endpoints"
    });
    const blocks = new ContextBlocks([{ label: "knowledge", provider }]);
    await blocks.load();
    const tools = await blocks.tools();
    const tool = tools.search_context as unknown as SearchToolFn;

    const result = await tool.execute({
      label: "knowledge",
      query: "deployment"
    });
    expect(result).toContain("meeting-notes");
    expect(result).toContain("deployment timeline");
  });

  it("returns no results message when nothing matches", async () => {
    const provider = new ReadonlySearchProvider({
      readme: "Hello world"
    });
    const blocks = new ContextBlocks([{ label: "knowledge", provider }]);
    await blocks.load();
    const tools = await blocks.tools();
    const tool = tools.search_context as unknown as SearchToolFn;

    const result = await tool.execute({
      label: "knowledge",
      query: "nonexistent"
    });
    expect(result).toContain("No results");
  });
});

// ── set_context with search blocks ─────────────────────────────

type SetToolFn = {
  execute: (args: {
    label: string;
    content: string;
    key?: string;
  }) => Promise<string>;
};

describe("set_context with search blocks", () => {
  it("indexes content and makes it searchable", async () => {
    const provider = new MemorySearchProvider();
    const blocks = new ContextBlocks([{ label: "knowledge", provider }]);
    await blocks.load();
    const tools = await blocks.tools();

    const setTool = tools.set_context as unknown as SetToolFn;
    const result = await setTool.execute({
      label: "knowledge",
      key: "notes",
      content: "The deployment is scheduled for Friday"
    });
    expect(result).toContain("Indexed");

    const searchTool = tools.search_context as unknown as SearchToolFn;
    const searchResult = await searchTool.execute({
      label: "knowledge",
      query: "deployment"
    });
    expect(searchResult).toContain("Friday");
  });

  it("errors when key missing for search block", async () => {
    const provider = new MemorySearchProvider();
    const blocks = new ContextBlocks([{ label: "knowledge", provider }]);
    await blocks.load();
    const tools = await blocks.tools();
    const tool = tools.set_context as unknown as SetToolFn;

    const result = await tool.execute({
      label: "knowledge",
      content: "no key provided"
    });
    expect(result).toContain("key is required");
  });

  it("updates block summary after indexing", async () => {
    const provider = new MemorySearchProvider();
    const blocks = new ContextBlocks([{ label: "knowledge", provider }]);
    await blocks.load();

    // Initially empty
    expect(blocks.getBlock("knowledge")?.content).toBe("");

    const tools = await blocks.tools();
    const setTool = tools.set_context as unknown as SetToolFn;
    await setTool.execute({
      label: "knowledge",
      key: "doc-1",
      content: "First document"
    });

    // Block content should now show the indexed entry
    const block = blocks.getBlock("knowledge");
    expect(block?.content).toContain("doc-1");
    expect(block?.content).toContain("1 entries");
  });
});
