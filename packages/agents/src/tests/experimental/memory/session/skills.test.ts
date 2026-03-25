import { describe, expect, it } from "vitest";
import {
  ContextBlocks,
  type ContextProvider,
  type WritableContextProvider
} from "../../../../experimental/memory/session/context";
import type { SkillProvider } from "../../../../experimental/memory/session/skills";

// ── In-memory providers for tests ──────────────────────────────

class ReadonlyProvider implements ContextProvider {
  constructor(private value: string | null = null) {}
  async get() {
    return this.value;
  }
}

class WritableProvider implements WritableContextProvider {
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

class MemorySkillProvider implements SkillProvider {
  private skills: Map<string, { content: string; description?: string }>;

  constructor(
    skills: Record<string, { content: string; description?: string }> = {}
  ) {
    this.skills = new Map(Object.entries(skills));
  }

  async get(): Promise<string | null> {
    const entries = Array.from(this.skills.entries()).map(
      ([key, { description }]) =>
        `- ${key}${description ? `: ${description}` : ""}`
    );
    return entries.length > 0 ? entries.join("\n") : null;
  }

  async load(key: string): Promise<string | null> {
    return this.skills.get(key)?.content ?? null;
  }

  async set(key: string, content: string, description?: string): Promise<void> {
    this.skills.set(key, { content, description });
  }
}

// ── Provider type detection ────────────────────────────────────

describe("Provider type detection", () => {
  it("readonly provider: no set_context tool", async () => {
    const blocks = new ContextBlocks([
      { label: "soul", provider: new ReadonlyProvider("identity") }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    expect(tools).not.toHaveProperty("set_context");
  });

  it("writable provider: set_context tool available", async () => {
    const blocks = new ContextBlocks([
      { label: "memory", provider: new WritableProvider("") }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    expect(tools).toHaveProperty("set_context");
  });

  it("skill provider: set_context, load_context, and unload_context tools", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({
          greeting: { content: "Say hello", description: "Greeting" }
        })
      }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    expect(tools).toHaveProperty("set_context");
    expect(tools).toHaveProperty("load_context");
    expect(tools).toHaveProperty("unload_context");
  });

  it("readonly block marked as readonly in system prompt", async () => {
    const blocks = new ContextBlocks([
      { label: "soul", provider: new ReadonlyProvider("identity") }
    ]);
    await blocks.load();
    const prompt = blocks.toSystemPrompt();
    expect(prompt).toContain("[readonly]");
  });

  it("writable block not marked as readonly", async () => {
    const blocks = new ContextBlocks([
      { label: "memory", provider: new WritableProvider("facts") }
    ]);
    await blocks.load();
    const prompt = blocks.toSystemPrompt();
    expect(prompt).not.toContain("[readonly]");
  });
});

// ── Skill blocks in system prompt ──────────────────────────────

describe("Skill blocks in system prompt", () => {
  it("renders skill metadata with load_context hint", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({
          "code-review": {
            content: "Review carefully",
            description: "Code review"
          },
          "sql-query": { content: "Write SQL", description: "SQL guide" }
        })
      }
    ]);
    await blocks.load();
    const prompt = blocks.toSystemPrompt();

    expect(prompt).toContain("SKILLS");
    expect(prompt).toContain("[loadable]");
    expect(prompt).toContain("code-review");
    expect(prompt).toContain("Code review");
    expect(prompt).toContain("sql-query");
    expect(prompt).toContain("SQL guide");
  });

  it("empty skill provider renders with loadable tag", async () => {
    const blocks = new ContextBlocks([
      { label: "skills", provider: new MemorySkillProvider() }
    ]);
    await blocks.load();
    const prompt = blocks.toSystemPrompt();
    // Skill blocks are writable, so they render even when empty
    expect(prompt).toContain("SKILLS");
    expect(prompt).toContain("[loadable]");
  });
});

// ── load_context tool ──────────────────────────────────────────

type ToolFn<T> = {
  execute: (args: T) => Promise<string>;
};

type LoadToolFn = ToolFn<{ label: string; key: string }>;
type UnloadToolFn = ToolFn<{ label: string; key: string }>;

describe("load_context tool", () => {
  it("loads skill content by key", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({
          "code-review": { content: "# Code Review\nCheck for bugs." }
        })
      }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    const tool = tools.load_context as unknown as LoadToolFn;
    const result = await tool.execute({ label: "skills", key: "code-review" });
    expect(result).toBe("# Code Review\nCheck for bugs.");
  });

  it("returns not found for unknown key", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({ exists: { content: "I exist" } })
      }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    const tool = tools.load_context as unknown as LoadToolFn;
    const result = await tool.execute({ label: "skills", key: "nope" });
    expect(result).toContain("Not found");
  });

  it("no load_context when no skill providers", async () => {
    const blocks = new ContextBlocks([
      { label: "memory", provider: new WritableProvider("") }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    expect(tools).not.toHaveProperty("load_context");
  });
});

// ── set_context tool ───────────────────────────────────────────

type SetToolFn = {
  execute: (args: {
    label: string;
    content: string;
    title?: string;
    action?: string;
  }) => Promise<string>;
};

describe("set_context tool", () => {
  it("writes to regular block", async () => {
    const provider = new WritableProvider("");
    const blocks = new ContextBlocks([
      { label: "memory", maxTokens: 1100, provider }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    const tool = tools.set_context as unknown as SetToolFn;
    const result = await tool.execute({ label: "memory", content: "new fact" });
    expect(result).toContain("Written to memory");
    expect(await provider.get()).toBe("new fact");
  });

  it("writes to skill block with title as key", async () => {
    const provider = new MemorySkillProvider();
    const blocks = new ContextBlocks([{ label: "skills", provider }]);
    await blocks.load();
    const tools = await blocks.tools();
    const tool = tools.set_context as unknown as SetToolFn;
    const result = await tool.execute({
      label: "skills",
      content: "Talk like a pirate",
      title: "Pirate style"
    });
    expect(result).toContain("Indexed");
    expect(await provider.load("pirate-style")).toBe("Talk like a pirate");
  });

  it("auto-generates key from content when no title for skill block", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({ x: { content: "x" } })
      }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    const tool = tools.set_context as unknown as SetToolFn;
    const result = await tool.execute({ label: "skills", content: "no key" });
    expect(result).toContain("Indexed");
  });

  it("rejects writes to readonly block", async () => {
    const blocks = new ContextBlocks([
      { label: "soul", provider: new ReadonlyProvider("identity") }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    expect(tools).not.toHaveProperty("set_context");
  });

  it("set_context with description persists and refreshes metadata", async () => {
    const provider = new MemorySkillProvider();
    const blocks = new ContextBlocks([{ label: "skills", provider }]);
    await blocks.load();

    // Initially empty
    expect(blocks.getBlock("skills")?.content).toBe("");

    const tools = await blocks.tools();
    const tool = tools.set_context as unknown as SetToolFn;

    // Write a skill with title (used as key slug and description)
    await tool.execute({
      label: "skills",
      content: "Say hello warmly",
      title: "Greeting instructions"
    });

    // Title should be slugified into the key
    const metadata = await provider.get();
    expect(metadata).toContain("greeting-instructions");

    // Block content should be refreshed with new metadata
    const block = blocks.getBlock("skills");
    expect(block?.content).toContain("greeting-instructions");
  });

  it("set_context without description stores content only", async () => {
    const provider = new MemorySkillProvider();
    const blocks = new ContextBlocks([{ label: "skills", provider }]);
    await blocks.load();

    const tools = await blocks.tools();
    const tool = tools.set_context as unknown as SetToolFn;

    await tool.execute({
      label: "skills",
      content: "Just content, no desc"
    });

    // Key is auto-generated from content slug
    expect(await provider.load("just-content-no-desc")).toBe(
      "Just content, no desc"
    );
  });

  it("multiple set_context calls accumulate skills in metadata", async () => {
    const provider = new MemorySkillProvider();
    const blocks = new ContextBlocks([{ label: "skills", provider }]);
    await blocks.load();

    const tools = await blocks.tools();
    const tool = tools.set_context as unknown as SetToolFn;

    await tool.execute({
      label: "skills",
      content: "Content A",
      title: "First skill"
    });
    await tool.execute({
      label: "skills",
      content: "Content B",
      title: "Second skill"
    });

    const block = blocks.getBlock("skills");
    expect(block?.content).toContain("first-skill");
    expect(block?.content).toContain("second-skill");

    // Both loadable by slugified title
    expect(await provider.load("first-skill")).toBe("Content A");
    expect(await provider.load("second-skill")).toBe("Content B");
  });
});

// ── unload_context tool ─────────────────────────────────────────

describe("unload_context tool", () => {
  it("tracks loaded skills after load_context", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({
          "code-review": { content: "Review carefully" }
        })
      }
    ]);
    await blocks.load();

    expect(blocks.getLoadedSkillKeys().size).toBe(0);

    const tools = await blocks.tools();
    const loadTool = tools.load_context as unknown as LoadToolFn;
    await loadTool.execute({ label: "skills", key: "code-review" });

    expect(blocks.getLoadedSkillKeys().has("skills:code-review")).toBe(true);
  });

  it("unloads a loaded skill", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({
          "code-review": { content: "Review carefully" }
        })
      }
    ]);
    await blocks.load();

    // Load first
    const tools = await blocks.tools();
    const loadTool = tools.load_context as unknown as LoadToolFn;
    await loadTool.execute({ label: "skills", key: "code-review" });
    expect(blocks.getLoadedSkillKeys().size).toBe(1);

    // Unload
    const unloadTool = tools.unload_context as unknown as UnloadToolFn;
    const result = await unloadTool.execute({
      label: "skills",
      key: "code-review"
    });
    expect(result).toContain("Unloaded");
    expect(blocks.getLoadedSkillKeys().size).toBe(0);
  });

  it("returns error when unloading a skill that is not loaded", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({
          "code-review": { content: "Review carefully" }
        })
      }
    ]);
    await blocks.load();

    const tools = await blocks.tools();
    const unloadTool = tools.unload_context as unknown as UnloadToolFn;
    const result = await unloadTool.execute({
      label: "skills",
      key: "code-review"
    });
    expect(result).toContain("not currently loaded");
  });

  it("calls unload callback when unloading", async () => {
    const unloaded: Array<{ label: string; key: string }> = [];
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({
          pirate: { content: "Talk like a pirate" }
        })
      }
    ]);
    blocks.setUnloadCallback((label, key) => {
      unloaded.push({ label, key });
    });
    await blocks.load();

    // Load then unload
    const tools = await blocks.tools();
    const loadTool = tools.load_context as unknown as LoadToolFn;
    await loadTool.execute({ label: "skills", key: "pirate" });

    const unloadTool = tools.unload_context as unknown as UnloadToolFn;
    await unloadTool.execute({ label: "skills", key: "pirate" });

    expect(unloaded).toEqual([{ label: "skills", key: "pirate" }]);
  });

  it("can re-load after unloading", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({
          pirate: { content: "Talk like a pirate" }
        })
      }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    const loadTool = tools.load_context as unknown as LoadToolFn;
    const unloadTool = tools.unload_context as unknown as UnloadToolFn;

    // Load → unload → re-load
    await loadTool.execute({ label: "skills", key: "pirate" });
    await unloadTool.execute({ label: "skills", key: "pirate" });
    expect(blocks.getLoadedSkillKeys().size).toBe(0);

    const content = await loadTool.execute({ label: "skills", key: "pirate" });
    expect(content).toBe("Talk like a pirate");
    expect(blocks.getLoadedSkillKeys().has("skills:pirate")).toBe(true);
  });

  it("clearSkillState resets all tracking", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({
          a: { content: "A" },
          b: { content: "B" }
        })
      }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    const loadTool = tools.load_context as unknown as LoadToolFn;

    await loadTool.execute({ label: "skills", key: "a" });
    await loadTool.execute({ label: "skills", key: "b" });
    expect(blocks.getLoadedSkillKeys().size).toBe(2);

    blocks.clearSkillState();
    expect(blocks.getLoadedSkillKeys().size).toBe(0);
  });

  it("no unload_context when no skill providers", async () => {
    const blocks = new ContextBlocks([
      { label: "memory", provider: new WritableProvider("") }
    ]);
    await blocks.load();
    const tools = await blocks.tools();
    expect(tools).not.toHaveProperty("unload_context");
  });

  it("unload_context description lists currently loaded skills", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: new MemorySkillProvider({
          pirate: { content: "Arr" },
          formal: { content: "Indeed" }
        })
      }
    ]);
    await blocks.load();

    // Load one skill
    await blocks.loadSkill("skills", "pirate");

    // Re-generate tools — description should mention the loaded skill
    const tools = await blocks.tools();
    const desc = (tools.unload_context as { description: string }).description;
    expect(desc).toContain("skills:pirate");
  });
});
