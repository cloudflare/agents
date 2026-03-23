import { describe, expect, it } from "vitest";
import { Session } from "../../../../experimental/memory/session/session";
import {
  ContextBlocks,
  type ContextProvider
} from "../../../../experimental/memory/session/context";
import type { SessionProvider } from "../../../../experimental/memory/session/provider";

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
      { label: "soul", defaultContent: "You are helpful.", readonly: true },
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
      { label: "soul", defaultContent: "identity", readonly: true }
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
      { label: "soul", defaultContent: "helpful", readonly: true },
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
        { label: "soul", defaultContent: "identity", readonly: true },
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
        { label: "soul", defaultContent: "identity", readonly: true },
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
      context: [{ label: "soul", defaultContent: "identity", readonly: true }]
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
      defaultContent: "You are helpful.",
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
      .withContext("soul", { defaultContent: "Be kind.", readonly: true })
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

// ── DO-backed tests (session isolation, system prompt persistence) ──

type TestResult = Promise<{ success: boolean; error?: string }>;

interface MultiSessionTestAgent {
  testSessionIsolation(): TestResult;
  testCompactionIsolation(): TestResult;
  testSystemPromptPersistence(): TestResult;
  testSystemPromptRefresh(): TestResult;
  testClearIsolation(): TestResult;
  testManagerCreateAndGet(): TestResult;
  testManagerList(): TestResult;
  testManagerDelete(): TestResult;
  testManagerRename(): TestResult;
  testManagerSearch(): TestResult;
  testSessionSearchTool(): TestResult;
  testContextBlockProxies(): TestResult;
  testAgentContextProvider(): TestResult;
}

async function getMultiSessionAgent(name: string): Promise<MultiSessionTestAgent> {
  return getAgentByName(env.TestMultiSessionAgent, name) as unknown as Promise<MultiSessionTestAgent>;
}

describe("Session — multi-session isolation (DO-backed)", () => {
  let instanceName: string;

  beforeEach(() => {
    instanceName = `multi-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it("messages in different sessions are isolated", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    const result = await agent.testSessionIsolation();
    expect(result).toEqual({ success: true });
  });

  it("compaction overlays are scoped to session", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    const result = await agent.testCompactionIsolation();
    expect(result).toEqual({ success: true });
  });

  it("system prompt is persisted and frozen across calls", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    const result = await agent.testSystemPromptPersistence();
    expect(result).toEqual({ success: true });
  });

  it("refreshSystemPrompt updates stored prompt", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    const result = await agent.testSystemPromptRefresh();
    expect(result).toEqual({ success: true });
  });

  it("clearMessages only clears target session", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    const result = await agent.testClearIsolation();
    expect(result).toEqual({ success: true });
  });
});

describe("SessionManager (DO-backed)", () => {
  let instanceName: string;
  beforeEach(() => { instanceName = `mgr-${Date.now()}-${Math.random().toString(36).slice(2)}`; });

  it("create and get session", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    expect(await agent.testManagerCreateAndGet()).toEqual({ success: true });
  });

  it("list sessions", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    expect(await agent.testManagerList()).toEqual({ success: true });
  });

  it("delete session and its messages", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    expect(await agent.testManagerDelete()).toEqual({ success: true });
  });

  it("rename session", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    expect(await agent.testManagerRename()).toEqual({ success: true });
  });

  it("cross-session search", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    expect(await agent.testManagerSearch()).toEqual({ success: true });
  });
});

describe("Session tools and context (DO-backed)", () => {
  let instanceName: string;
  beforeEach(() => { instanceName = `tools-${Date.now()}-${Math.random().toString(36).slice(2)}`; });

  it("session_search tool searches messages", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    expect(await agent.testSessionSearchTool()).toEqual({ success: true });
  });

  it("replaceContextBlock / appendContextBlock / getContextBlock", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    expect(await agent.testContextBlockProxies()).toEqual({ success: true });
  });

  it("AgentContextProvider get/set persistence", async () => {
    const agent = await getMultiSessionAgent(instanceName);
    expect(await agent.testAgentContextProvider()).toEqual({ success: true });
  });
});
