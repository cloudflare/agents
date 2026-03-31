import { describe, expect, it } from "vitest";
import {
  SkillsManager,
  type SkillProvider,
  type SkillEntry
} from "../../../../experimental/memory/session/catalog";

// ── In-memory skill provider for tests ─────────────────────────

class MemorySkillProvider implements SkillProvider {
  private skills: Map<string, { content: string; description?: string }>;

  constructor(
    skills: Record<string, { content: string; description?: string }> = {}
  ) {
    this.skills = new Map(Object.entries(skills));
  }

  async metadata(): Promise<SkillEntry[]> {
    return Array.from(this.skills.entries()).map(([key, { content, description }]) => ({
      key,
      description,
      size: content.length,
    }));
  }

  async get(key: string): Promise<string | null> {
    return this.skills.get(key)?.content ?? null;
  }
}

// ── SkillsManager tests ────────────────────────────────────────

describe("SkillsManager", () => {
  it("hasProviders returns false when empty", () => {
    const manager = new SkillsManager();
    expect(manager.hasProviders()).toBe(false);
  });

  it("hasProviders returns true after add", () => {
    const manager = new SkillsManager();
    manager.add(new MemorySkillProvider());
    expect(manager.hasProviders()).toBe(true);
  });

  it("renderSystemPrompt is empty before load", () => {
    const manager = new SkillsManager();
    manager.add(
      new MemorySkillProvider({
        "code-review": { content: "Review code carefully", description: "Code review instructions" }
      })
    );
    expect(manager.renderSystemPrompt()).toBe("");
  });

  it("renderSystemPrompt renders skill metadata after load", async () => {
    const manager = new SkillsManager();
    manager.add(
      new MemorySkillProvider({
        "code-review": { content: "Review code carefully", description: "Code review instructions" },
        "sql-query": { content: "Write efficient SQL", description: "SQL writing guide" }
      })
    );

    await manager.load();
    const prompt = manager.renderSystemPrompt();

    expect(prompt).toContain("SKILLS");
    expect(prompt).toContain("load_skill");
    expect(prompt).toContain("code-review");
    expect(prompt).toContain("Code review instructions");
    expect(prompt).toContain("sql-query");
    expect(prompt).toContain("SQL writing guide");
    expect(prompt).toContain("═");
  });

  it("renderSystemPrompt is empty when no skills exist", async () => {
    const manager = new SkillsManager();
    manager.add(new MemorySkillProvider());
    await manager.load();
    expect(manager.renderSystemPrompt()).toBe("");
  });

  it("renderSystemPrompt renders entries without descriptions", async () => {
    const manager = new SkillsManager();
    manager.add(
      new MemorySkillProvider({
        "my-skill": { content: "do stuff" }
      })
    );
    await manager.load();
    const prompt = manager.renderSystemPrompt();

    expect(prompt).toContain("my-skill");
    expect(prompt).not.toContain(":");
    // Should not have ": undefined" or similar
  });

  it("concatenates multiple providers", async () => {
    const manager = new SkillsManager();
    manager.add(
      new MemorySkillProvider({
        "skill-a": { content: "a", description: "From provider 1" }
      })
    );
    manager.add(
      new MemorySkillProvider({
        "skill-b": { content: "b", description: "From provider 2" }
      })
    );

    await manager.load();
    const prompt = manager.renderSystemPrompt();

    expect(prompt).toContain("skill-a");
    expect(prompt).toContain("skill-b");
    expect(prompt).toContain("From provider 1");
    expect(prompt).toContain("From provider 2");
  });
});

// ── load_skill tool tests ──────────────────────────────────────

type ToolExecuteFn = {
  execute: (args: { key: string }) => Promise<string>;
};

describe("load_skill tool", () => {
  it("tools() returns empty when no skills", async () => {
    const manager = new SkillsManager();
    manager.add(new MemorySkillProvider());
    await manager.load();
    expect(manager.tools()).toEqual({});
  });

  it("tools() returns load_skill when skills exist", async () => {
    const manager = new SkillsManager();
    manager.add(
      new MemorySkillProvider({
        "greeting": { content: "Say hello warmly", description: "Greeting skill" }
      })
    );
    await manager.load();

    const tools = manager.tools();
    expect(tools).toHaveProperty("load_skill");
    expect(tools.load_skill).toHaveProperty("description");
    expect(tools.load_skill).toHaveProperty("execute");
  });

  it("load_skill returns skill content", async () => {
    const manager = new SkillsManager();
    manager.add(
      new MemorySkillProvider({
        "code-review": { content: "# Code Review\nCheck for bugs.", description: "Review" }
      })
    );
    await manager.load();

    const tool = manager.tools().load_skill as unknown as ToolExecuteFn;
    const result = await tool.execute({ key: "code-review" });
    expect(result).toBe("# Code Review\nCheck for bugs.");
  });

  it("load_skill returns not found for unknown key", async () => {
    const manager = new SkillsManager();
    manager.add(
      new MemorySkillProvider({
        "exists": { content: "I exist" }
      })
    );
    await manager.load();

    const tool = manager.tools().load_skill as unknown as ToolExecuteFn;
    const result = await tool.execute({ key: "does-not-exist" });
    expect(result).toContain("Not found");
  });

  it("load_skill resolves correct provider with multiple providers", async () => {
    const manager = new SkillsManager();
    manager.add(
      new MemorySkillProvider({
        "skill-a": { content: "Content A" }
      })
    );
    manager.add(
      new MemorySkillProvider({
        "skill-b": { content: "Content B" }
      })
    );
    await manager.load();

    const tool = manager.tools().load_skill as unknown as ToolExecuteFn;
    expect(await tool.execute({ key: "skill-a" })).toBe("Content A");
    expect(await tool.execute({ key: "skill-b" })).toBe("Content B");
  });
});
