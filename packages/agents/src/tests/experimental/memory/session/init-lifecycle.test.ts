import { describe, expect, it } from "vitest";
import {
  ContextBlocks,
  type ContextProvider,
  type WritableContextProvider
} from "../../../../experimental/memory/session/context";
import type { SkillProvider } from "../../../../experimental/memory/session/skills";
import type { SearchProvider } from "../../../../experimental/memory/session/search";

// ── Providers that track init calls ────────────────────────────

class TrackingReadonlyProvider implements ContextProvider {
  initLabel: string | null = null;

  init(label: string) {
    this.initLabel = label;
  }

  async get() {
    return `content for ${this.initLabel}`;
  }
}

class TrackingWritableProvider implements WritableContextProvider {
  initLabel: string | null = null;
  written: string | null = null;

  init(label: string) {
    this.initLabel = label;
  }

  async get() {
    return this.written;
  }

  async set(content: string) {
    this.written = content;
  }
}

class TrackingSkillProvider implements SkillProvider {
  initLabel: string | null = null;
  private skills = new Map<string, { content: string; description?: string }>();

  init(label: string) {
    this.initLabel = label;
  }

  async get() {
    if (this.skills.size === 0) return null;
    return Array.from(this.skills.entries())
      .map(
        ([key, { description }]) =>
          `- ${key}${description ? `: ${description}` : ""}`
      )
      .join("\n");
  }

  async load(key: string) {
    return this.skills.get(key)?.content ?? null;
  }

  async set(key: string, content: string, description?: string) {
    this.skills.set(key, { content, description });
  }
}

class TrackingSearchProvider implements SearchProvider {
  initLabel: string | null = null;
  private entries = new Map<string, string>();

  init(label: string) {
    this.initLabel = label;
  }

  async get() {
    if (this.entries.size === 0) return null;
    return `${this.entries.size} entries`;
  }

  async search(query: string) {
    const q = query.toLowerCase();
    const results = Array.from(this.entries.entries())
      .filter(([, content]) => content.toLowerCase().includes(q))
      .map(([key, content]) => `[${key}] ${content}`);
    return results.length > 0 ? results.join("\n") : null;
  }

  async set(key: string, content: string) {
    this.entries.set(key, content);
  }
}

// ── Provider without init (should still work) ──────────────────

class NoInitProvider implements ContextProvider {
  async get() {
    return "static content";
  }
}

class NoInitWritableProvider implements WritableContextProvider {
  private value = "";

  async get() {
    return this.value || null;
  }

  async set(content: string) {
    this.value = content;
  }
}

// ── Tests ──────────────────────────────────────────────────────

describe("init(label) lifecycle", () => {
  it("calls init on readonly provider with correct label", async () => {
    const provider = new TrackingReadonlyProvider();
    const blocks = new ContextBlocks([{ label: "soul", provider }]);
    await blocks.load();
    expect(provider.initLabel).toBe("soul");
  });

  it("calls init on writable provider with correct label", async () => {
    const provider = new TrackingWritableProvider();
    const blocks = new ContextBlocks([{ label: "memory", provider }]);
    await blocks.load();
    expect(provider.initLabel).toBe("memory");
  });

  it("calls init on skill provider with correct label", async () => {
    const provider = new TrackingSkillProvider();
    const blocks = new ContextBlocks([{ label: "skills", provider }]);
    await blocks.load();
    expect(provider.initLabel).toBe("skills");
  });

  it("calls init on search provider with correct label", async () => {
    const provider = new TrackingSearchProvider();
    const blocks = new ContextBlocks([{ label: "knowledge", provider }]);
    await blocks.load();
    expect(provider.initLabel).toBe("knowledge");
  });

  it("calls init before get", async () => {
    const callOrder: string[] = [];
    const provider: ContextProvider = {
      init(label: string) {
        callOrder.push(`init:${label}`);
      },
      async get() {
        callOrder.push("get");
        return "content";
      }
    };
    const blocks = new ContextBlocks([{ label: "test", provider }]);
    await blocks.load();
    expect(callOrder).toEqual(["init:test", "get"]);
  });

  it("each provider gets its own label in multi-block config", async () => {
    const p1 = new TrackingReadonlyProvider();
    const p2 = new TrackingWritableProvider();
    const p3 = new TrackingSearchProvider();
    const blocks = new ContextBlocks([
      { label: "soul", provider: p1 },
      { label: "memory", provider: p2 },
      { label: "knowledge", provider: p3 }
    ]);
    await blocks.load();
    expect(p1.initLabel).toBe("soul");
    expect(p2.initLabel).toBe("memory");
    expect(p3.initLabel).toBe("knowledge");
  });

  it("works without init method (backward compat)", async () => {
    const provider = new NoInitProvider();
    const blocks = new ContextBlocks([{ label: "static", provider }]);
    await blocks.load();
    expect(blocks.getBlock("static")?.content).toBe("static content");
  });

  it("writable provider without init still works", async () => {
    const provider = new NoInitWritableProvider();
    const blocks = new ContextBlocks([{ label: "notes", provider }]);
    await blocks.load();
    const tools = await blocks.tools();
    expect(tools).toHaveProperty("set_context");
  });

  it("init is called only once even with multiple tool calls", async () => {
    const initCalls: string[] = [];
    const provider: WritableContextProvider = {
      init(label: string) {
        initCalls.push(label);
      },
      async get() {
        return null;
      },
      async set() {}
    };
    const blocks = new ContextBlocks([{ label: "memory", provider }]);
    await blocks.load();
    // tools() calls load() again but it's already loaded
    await blocks.tools();
    await blocks.tools();
    expect(initCalls).toEqual(["memory"]);
  });

  it("provider can use label in get() after init", async () => {
    const provider = new TrackingReadonlyProvider();
    const blocks = new ContextBlocks([{ label: "my-block", provider }]);
    await blocks.load();
    const block = blocks.getBlock("my-block");
    expect(block?.content).toBe("content for my-block");
  });

  it("search provider uses label from init for indexing", async () => {
    const provider = new TrackingSearchProvider();
    const blocks = new ContextBlocks([{ label: "docs", provider }]);
    await blocks.load();

    // Provider should have received label
    expect(provider.initLabel).toBe("docs");

    // Index and search should work
    const tools = await blocks.tools();

    type SetFn = {
      execute: (args: {
        label: string;
        content: string;
        key?: string;
      }) => Promise<string>;
    };
    type SearchFn = {
      execute: (args: { label: string; query: string }) => Promise<string>;
    };

    const setTool = tools.set_context as unknown as SetFn;
    await setTool.execute({
      label: "docs",
      key: "readme",
      content: "Hello world"
    });

    const searchTool = tools.search_context as unknown as SearchFn;
    const result = await searchTool.execute({ label: "docs", query: "hello" });
    expect(result).toContain("Hello world");
  });
});
