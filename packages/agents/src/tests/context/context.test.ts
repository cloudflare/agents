import { describe, expect, it } from "vitest";
import {
  ContextBlocks,
  type ContextProvider,
  type WritableContextProvider
} from "../../context";

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

    const frozen = await blocks.freezeSystemPrompt();
    await blocks.setBlock("memory", "likes Workers");

    expect(await blocks.freezeSystemPrompt()).toBe(frozen);
    expect(frozen).toContain("SOUL");
    expect(frozen).toContain("You are helpful.");
    expect(frozen).toContain("likes TypeScript");
    expect(frozen).not.toContain("<context_block");

    const refreshed = await blocks.refreshSystemPrompt();
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
});

class ChangingProvider implements ContextProvider {
  inits = 0;
  constructor(public value: string | null) {}

  init(): void {
    this.inits++;
  }

  async get(): Promise<string | null> {
    return this.value;
  }
}

describe("context reminders", () => {
  it("reminds with a changed block's current value until a refresh promotes it", async () => {
    const date = new ChangingProvider("Today is 2026-09-28.");
    const facts = new ChangingProvider("Facts v1");
    const blocks = new ContextBlocks([
      { label: "environment", provider: date, whenChanged: "remind" },
      { label: "facts", provider: facts }
    ]);

    expect(await blocks.reminder()).toBeNull();
    const frozen = await blocks.freezeSystemPrompt();
    expect(await blocks.reminder()).toBeNull();

    date.value = "Today is 2026-09-29.";
    facts.value = "Facts v2";
    const reminder = await blocks.reminder();
    expect(reminder).toContain("replace the ones in the system prompt");
    expect(reminder).toContain("ENVIRONMENT [readonly]");
    expect(reminder).toContain("Today is 2026-09-29.");
    expect(reminder).not.toContain("FACTS");
    expect(await blocks.freezeSystemPrompt()).toBe(frozen);
    expect(blocks.getBlock("environment")?.content).toBe(
      "Today is 2026-09-29."
    );
    expect(await blocks.reminder()).toBe(reminder);

    const refreshed = await blocks.refreshSystemPrompt();
    expect(refreshed).toContain("Today is 2026-09-29.");
    expect(await blocks.reminder()).toBeNull();
    expect(date.inits).toBe(2);
  });

  it("compares against the stored prompt, so a restart still sees the change", async () => {
    const promptStore = new MemoryProvider(null);
    const configs = (value: string) => [
      {
        label: "environment",
        provider: new ChangingProvider(value),
        whenChanged: "remind" as const
      }
    ];
    await new ContextBlocks(
      configs("2026-09-28"),
      promptStore
    ).freezeSystemPrompt();

    expect(
      await new ContextBlocks(configs("2026-09-28"), promptStore).reminder()
    ).toBeNull();
    const woke = new ContextBlocks(configs("2026-09-29"), promptStore);
    expect(await woke.reminder()).toContain("2026-09-29");
    expect(await woke.freezeSystemPrompt()).toContain("2026-09-28");
  });

  it.each([
    ["shrinks at the end", "Monday, 2026-09-28", "Monday"],
    ["loses a trailing newline", "Monday\n", "Monday"],
    ["grows at the start", "2026-09-28", "Monday 2026-09-28"],
    ["becomes empty", "Monday", ""],
    ["gains content after rendering empty", "", "Monday"]
  ])("counts a block that %s as changed", async (_case, before, after) => {
    for (const position of ["first", "last"] as const) {
      const environment = new ChangingProvider(before);
      const env = {
        label: "environment",
        provider: environment,
        whenChanged: "remind" as const
      };
      const other = { label: "soul", provider: new ReadonlyProvider("Hi.") };
      const blocks = new ContextBlocks(
        position === "first" ? [env, other] : [other, env]
      );
      await blocks.freezeSystemPrompt();
      environment.value = after;
      expect(await blocks.reminder(), position).toContain("ENVIRONMENT");
    }
  });

  it("does not remind about a block that stayed empty", async () => {
    const blocks = new ContextBlocks([
      {
        label: "environment",
        description: "Where you run",
        provider: new ChangingProvider(null),
        whenChanged: "remind"
      },
      { label: "environment-extra", provider: new ReadonlyProvider("x") }
    ]);
    const frozen = await blocks.freezeSystemPrompt();
    expect(frozen).toContain("ENVIRONMENT (Where you run) [readonly]");
    expect(await blocks.reminder()).toBeNull();
  });

  it("does not mistake another label's section for an empty block's", async () => {
    const blocks = new ContextBlocks([
      {
        label: "environment",
        provider: new ChangingProvider(null),
        whenChanged: "remind"
      },
      {
        label: "environment (archive)",
        provider: new ReadonlyProvider("old")
      }
    ]);
    await blocks.freezeSystemPrompt();
    expect(await blocks.reminder()).toBeNull();
  });
});
