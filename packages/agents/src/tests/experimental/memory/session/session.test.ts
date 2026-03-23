import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { describe, expect, it, beforeEach } from "vitest";
import { getAgentByName } from "../../../..";
import { Session } from "../../../../experimental/memory/session/session";
import { ContextBlocks, type ContextBlockProvider } from "../../../../experimental/memory/session/context";
import type { SessionProvider } from "../../../../experimental/memory/session/provider";

// ── In-memory block provider for pure unit tests ────────────────

class MemoryBlockProvider implements ContextBlockProvider {
  private value: string | null;
  constructor(initial: string | null = null) { this.value = initial; }
  async get() { return this.value; }
  async set(content: string) { this.value = content; }
}

// ── Pure unit tests (no DO needed) ──────────────────────────────

describe("ContextBlocks — frozen system prompt", () => {
  it("toSystemPrompt returns same value on repeated calls", async () => {
    const blocks = new ContextBlocks([
      { label: "soul", defaultContent: "You are helpful.", readonly: true },
      { label: "memory", description: "Facts", maxTokens: 1100, provider: new MemoryBlockProvider("likes TypeScript") },
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
      { label: "memory", maxTokens: 1100, provider },
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
      { label: "memory", maxTokens: 1100, provider: new MemoryBlockProvider("v1") },
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
      { label: "soul", defaultContent: "identity", readonly: true },
    ]);
    await blocks.load();
    await expect(blocks.setBlock("soul", "hacked")).rejects.toThrow("readonly");
  });

  it("maxTokens enforcement", async () => {
    const blocks = new ContextBlocks([
      { label: "memory", maxTokens: 10, provider: new MemoryBlockProvider("") },
    ]);
    await blocks.load();
    const long = "word ".repeat(50);
    await expect(blocks.setBlock("memory", long)).rejects.toThrow("exceeds maxTokens");
  });

  it("uses plain text format, not XML", async () => {
    const blocks = new ContextBlocks([
      { label: "soul", defaultContent: "helpful", readonly: true },
      { label: "memory", description: "Facts", maxTokens: 500, provider: new MemoryBlockProvider("coffee") },
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
  addCompaction: () => ({ id: "", summary: "", fromMessageId: "", toMessageId: "", createdAt: "" }),
  getCompactions: () => [],
};

describe("Session — tools() without load", () => {
  it("tools() returns tool schema with loaded blocks", async () => {
    const session = new Session(stubProvider, {
      context: [
        { label: "soul", defaultContent: "identity", readonly: true },
        { label: "memory", description: "Learned facts", maxTokens: 1100, provider: new MemoryBlockProvider("") },
        { label: "todos", description: "Task list", maxTokens: 2000, provider: new MemoryBlockProvider("") },
      ],
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
        { label: "memory", description: "Facts", maxTokens: 1100, provider: memProvider },
      ],
    });

    const tool = (await session.tools()).update_context as { execute: (args: { label: string; content: string; action?: string }) => Promise<string> };

    const result = await tool.execute({ label: "memory", content: "user likes coffee" });
    expect(result).toContain("Written to memory");
    expect(result).toContain("tokens");
    expect(await memProvider.get()).toBe("user likes coffee");
  });

  it("tools() execute append works", async () => {
    const memProvider = new MemoryBlockProvider("fact1");
    const session = new Session(stubProvider, {
      context: [
        { label: "memory", description: "Facts", maxTokens: 1100, provider: memProvider },
      ],
    });

    const tool = (await session.tools()).update_context as { execute: (args: { label: string; content: string; action?: string }) => Promise<string> };
    const result = await tool.execute({ label: "memory", content: "\nfact2", action: "append" });
    expect(result).toContain("Written to memory");
    expect(await memProvider.get()).toBe("fact1\nfact2");
  });

  it("tools() execute rejects readonly blocks gracefully", async () => {
    const session = new Session(stubProvider, {
      context: [
        { label: "soul", defaultContent: "identity", readonly: true },
        { label: "memory", description: "Facts", maxTokens: 1100, provider: new MemoryBlockProvider("") },
      ],
    });

    const tool = (await session.tools()).update_context as { execute: (args: { label: string; content: string }) => Promise<string> };
    const result = await tool.execute({ label: "soul", content: "hacked" });
    expect(result).toContain("Error");
    expect(result).toContain("readonly");
  });

  it("tools() returns empty when no writable blocks", async () => {
    const session = new Session(stubProvider, {
      context: [
        { label: "soul", defaultContent: "identity", readonly: true },
      ],
    });
    expect(Object.keys(await session.tools())).toHaveLength(0);
  });
});
