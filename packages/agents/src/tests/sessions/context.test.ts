import { describe, expect, it } from "vitest";
import {
  ContextBlocks,
  type ContextProvider,
  type WritableContextProvider
} from "../../sessions/context";

class ReadonlyProvider implements ContextProvider {
  constructor(private readonly value: string | null) {}

  async get(): Promise<string | null> {
    return this.value;
  }
}

class MemoryProvider implements WritableContextProvider {
  constructor(private value: string | null = null) {}

  async get(): Promise<string | null> {
    return this.value;
  }

  async set(content: string): Promise<void> {
    this.value = content;
  }
}

describe("Sessions context blocks", () => {
  it("freezes a plain-text prompt until explicitly refreshed", async () => {
    const memory = new MemoryProvider("likes TypeScript");
    const blocks = new ContextBlocks([
      {
        label: "soul",
        provider: new ReadonlyProvider("You are helpful.")
      },
      {
        label: "memory",
        description: "Facts",
        maxTokens: 1_100,
        provider: memory
      }
    ]);
    await blocks.load();

    const frozen = blocks.toSystemPrompt();
    await blocks.setBlock("memory", "likes Workers");

    expect(blocks.toSystemPrompt()).toBe(frozen);
    expect(frozen).toContain("SOUL");
    expect(frozen).toContain("You are helpful.");
    expect(frozen).toContain("likes TypeScript");
    expect(frozen).not.toContain("<context_block");

    const refreshed = blocks.refreshSnapshot();
    expect(refreshed).toContain("likes Workers");
    expect(refreshed).not.toContain("likes TypeScript");
  });

  it("persists empty cached prompts instead of treating them as absent", async () => {
    const promptStore = new MemoryProvider(null);
    const blocks = new ContextBlocks([], promptStore);

    expect(await blocks.freezeSystemPrompt()).toBe("");
    expect(await promptStore.get()).toBe("");

    const second = new ContextBlocks(
      [{ label: "new", provider: new ReadonlyProvider("not rendered") }],
      promptStore
    );
    expect(await second.freezeSystemPrompt()).toBe("");
  });

  it("enforces readonly and token limits", async () => {
    const blocks = new ContextBlocks([
      { label: "soul", provider: new ReadonlyProvider("identity") },
      {
        label: "memory",
        maxTokens: 10,
        provider: new MemoryProvider("")
      }
    ]);
    await blocks.load();

    await expect(blocks.setBlock("soul", "changed")).rejects.toThrow(
      "readonly"
    );
    await expect(blocks.setBlock("memory", "word ".repeat(50))).rejects.toThrow(
      "exceeds maxTokens"
    );
  });

  it("renders empty skill-capable blocks so their tools stay discoverable", async () => {
    const blocks = new ContextBlocks([
      {
        label: "skills",
        provider: {
          get: async () => null,
          load: async () => null
        }
      }
    ]);
    await blocks.load();

    expect(blocks.toSystemPrompt()).toContain("SKILLS");
    expect(blocks.toSystemPrompt()).toContain("[loadable]");
  });
});
