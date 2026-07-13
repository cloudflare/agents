import { describe, expect, it } from "vitest";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import type { IdSource } from "../../kernel/ids.js";
import { userMessage, assistantMessage, type ChatMessage, type ToolPart } from "../messages/model.js";
import { createSession, type ContextProviderLike, type SessionConfig, type Session } from "./session.js";
import type { KeyValueStore } from "../../ports/storage.js";
import type { Clock } from "../../ports/clock.js";

function counterIds(prefix = ""): IdSource {
  let n = 0;
  return {
    newId(p: string) {
      n += 1;
      return `${prefix}${p}_${n}`;
    },
  };
}

function makeDeps(store?: KeyValueStore, clock?: Clock) {
  return { store: store ?? createMemoryKeyValueStore(), clock: clock ?? createTestClock(), ids: counterIds() };
}

function session(config: SessionConfig, store?: KeyValueStore, clock?: Clock): Session {
  return createSession(makeDeps(store, clock), config);
}

function writableProvider(initial = ""): ContextProviderLike & { value: string } {
  const state = { value: initial };
  return {
    get value() {
      return state.value;
    },
    set value(v: string) {
      state.value = v;
    },
    async get() {
      return state.value;
    },
    async set(c: string) {
      state.value = c;
    },
  };
}

function skillProvider(docs: Record<string, string>): ContextProviderLike {
  return {
    async get() {
      return `skills: ${Object.keys(docs).join(", ")}`;
    },
    async load(key: string) {
      return docs[key] ?? null;
    },
  };
}

function searchProvider(items: Array<{ key: string; excerpt: string; body: string }>): ContextProviderLike {
  return {
    async get() {
      return "search index";
    },
    async search(q: string) {
      return items.filter((i) => i.body.includes(q)).map((i) => ({ key: i.key, excerpt: i.excerpt }));
    },
  };
}

function readOnlyProvider(text: string): ContextProviderLike {
  return { async get() { return text; } };
}

function toolPartOf(message: ChatMessage): ToolPart {
  const part = message.parts.find((p) => p.type.startsWith("tool-"));
  return part as ToolPart;
}

// ---------------------------------------------------------------------------

describe("createSession: messages & history", () => {
  it("appendMessage auto-parents to the latest leaf; getHistory walks root to leaf", async () => {
    const s = session({ blocks: [] });
    await s.appendMessage(userMessage("hi", "m1"));
    await s.appendMessage(assistantMessage([{ type: "text", text: "hello" }], "m2"));
    await s.appendMessage(userMessage("bye", "m3"));

    const history = await s.getHistory();
    expect(history.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("explicit parentId creates a branch off an earlier message", async () => {
    const s = session({ blocks: [] });
    await s.appendMessage(userMessage("hi", "m1"));
    await s.appendMessage(assistantMessage([{ type: "text", text: "hello" }], "m2"));
    // Branch from m1 instead of continuing from m2.
    await s.appendMessage(userMessage("actually...", "m1b"), "m1");

    const branches = await s.getBranches("m1");
    expect(branches.map((m) => m.id).sort()).toEqual(["m1b", "m2"]);

    // getHistory() with no argument follows the *latest* appended leaf.
    const history = await s.getHistory();
    expect(history.map((m) => m.id)).toEqual(["m1", "m1b"]);

    // getHistory(leafId) can still walk the other branch.
    const otherBranch = await s.getHistory("m2");
    expect(otherBranch.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("getLatestLeaf returns the most recently appended message", async () => {
    const s = session({ blocks: [] });
    expect(await s.getLatestLeaf()).toBeUndefined();
    await s.appendMessage(userMessage("hi", "m1"));
    expect((await s.getLatestLeaf())?.id).toBe("m1");
    await s.appendMessage(userMessage("again", "m2"));
    expect((await s.getLatestLeaf())?.id).toBe("m2");
  });

  it("getPathLength reflects the length of the current root-to-leaf chain", async () => {
    const s = session({ blocks: [] });
    expect(await s.getPathLength()).toBe(0);
    await s.appendMessage(userMessage("a", "m1"));
    await s.appendMessage(userMessage("b", "m2"));
    expect(await s.getPathLength()).toBe(2);
  });

  it("updateMessage replaces content in place, preserving position and parentage", async () => {
    const s = session({ blocks: [] });
    await s.appendMessage(userMessage("a", "m1"));
    await s.appendMessage(userMessage("b", "m2"));
    await s.updateMessage(userMessage("b-edited", "m2"));

    const history = await s.getHistory();
    expect(history.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(history[1]!.parts).toEqual([{ type: "text", text: "b-edited" }]);
  });

  it("updateMessage throws NotFoundError for an unknown id", async () => {
    const s = session({ blocks: [] });
    await expect(s.updateMessage(userMessage("x", "missing"))).rejects.toThrow();
  });

  it("deleteMessages removes messages and moves the leaf pointer to the parent if the leaf was deleted", async () => {
    const s = session({ blocks: [] });
    await s.appendMessage(userMessage("a", "m1"));
    await s.appendMessage(userMessage("b", "m2"));
    await s.deleteMessages(["m2"]);

    expect((await s.getLatestLeaf())?.id).toBe("m1");
    expect((await s.getHistory()).map((m) => m.id)).toEqual(["m1"]);
  });

  it("clearMessages wipes the whole tree", async () => {
    const s = session({ blocks: [] });
    await s.appendMessage(userMessage("a", "m1"));
    await s.appendMessage(userMessage("b", "m2"));
    await s.clearMessages();

    expect(await s.getHistory()).toEqual([]);
    expect(await s.getLatestLeaf()).toBeUndefined();
    expect(await s.getPathLength()).toBe(0);
  });
});

describe("createSession: context blocks & providers", () => {
  it("a provider with only get() produces a read-only block (no write tools)", async () => {
    const s = session({ blocks: [{ label: "docs", provider: readOnlyProvider("static content") }] });
    const block = await s.getContextBlock("docs");
    expect(block?.writable).toBe(false);
    expect(block?.isSkill).toBe(false);
    expect(block?.isSearchable).toBe(false);
    expect(block?.content).toBe("static content");

    const tools = await s.tools();
    expect(tools.set_context).toBeUndefined();
  });

  it("no explicit provider defaults to a KV-backed writable provider", async () => {
    const s = session({ blocks: [{ label: "notes" }] });
    await s.replaceContextBlock("notes", "hello");
    const block = await s.getContextBlock("notes");
    expect(block?.writable).toBe(true);
    expect(block?.content).toBe("hello");
  });

  it("default provider content persists across sessions over the same store/sessionId", async () => {
    const store = createMemoryKeyValueStore();
    const s1 = session({ sessionId: "sess-1", blocks: [{ label: "notes" }] }, store);
    await s1.replaceContextBlock("notes", "persisted");

    const s2 = session({ sessionId: "sess-1", blocks: [{ label: "notes" }] }, store);
    const block = await s2.getContextBlock("notes");
    expect(block?.content).toBe("persisted");
  });

  it("a skill provider (get+load) produces load_context/unload_context tools", async () => {
    const s = session({
      blocks: [{ label: "skills", provider: skillProvider({ recipe: "flour, water, salt" }) }],
    });
    const tools = await s.tools();
    expect(tools.load_context).toBeDefined();
    expect(tools.unload_context).toBeDefined();
    expect(tools.search_context).toBeUndefined();
    expect(tools.set_context).toBeUndefined();
  });

  it("a search provider (get+search) produces the search_context tool", async () => {
    const s = session({
      blocks: [
        {
          label: "kb",
          provider: searchProvider([{ key: "a", excerpt: "about apples", body: "apples are red" }]),
        },
      ],
    });
    const tools = await s.tools();
    expect(tools.search_context).toBeDefined();
    expect(tools.load_context).toBeUndefined();
  });

  it("addContext registers a runtime block and removeContext removes it", async () => {
    const s = session({ blocks: [] });
    await s.addContext("scratch", { provider: writableProvider() });
    expect(await s.getContextBlock("scratch")).toBeDefined();
    s.removeContext("scratch");
    expect(await s.getContextBlock("scratch")).toBeUndefined();
  });

  it("calls provider.init(label) lazily on first use", async () => {
    let initedWith: string | undefined;
    const provider: ContextProviderLike = {
      async init(label) {
        initedWith = label;
      },
      async get() {
        return "content";
      },
    };
    const s = session({ blocks: [{ label: "lazy", provider }] });
    expect(initedWith).toBeUndefined();
    await s.getContextBlock("lazy");
    expect(initedWith).toBe("lazy");
  });

  it("replaceContextBlock and appendContextBlock write through the provider", async () => {
    const s = session({ blocks: [{ label: "notes", provider: writableProvider("start") }] });
    await s.appendContextBlock("notes", "-more");
    expect((await s.getContextBlock("notes"))?.content).toBe("start-more");
    await s.replaceContextBlock("notes", "reset");
    expect((await s.getContextBlock("notes"))?.content).toBe("reset");
  });

  it("replaceContextBlock throws when the block is read-only", async () => {
    const s = session({ blocks: [{ label: "docs", provider: readOnlyProvider("x") }] });
    await expect(s.replaceContextBlock("docs", "y")).rejects.toThrow();
  });

  it("replaceContextBlock throws when the new content would exceed maxTokens", async () => {
    const s = session({
      blocks: [{ label: "notes", maxTokens: 1, provider: writableProvider() }],
    });
    await expect(s.replaceContextBlock("notes", "way more than one token of text")).rejects.toThrow();
  });
});

describe("createSession: system prompt rendering", () => {
  it("renders blocks in declaration order with an uppercased label header and description", async () => {
    const s = session({
      blocks: [
        { label: "persona", description: "Who you are", provider: readOnlyProvider("A helpful assistant.") },
        { label: "notes", provider: writableProvider("scratch notes") },
      ],
    });
    const prompt = await s.freezeSystemPrompt();
    const personaIdx = prompt.indexOf("PERSONA");
    const notesIdx = prompt.indexOf("NOTES");
    expect(personaIdx).toBeGreaterThanOrEqual(0);
    expect(notesIdx).toBeGreaterThan(personaIdx);
    expect(prompt).toContain("Who you are");
    expect(prompt).toContain("A helpful assistant.");
    expect(prompt).toContain("scratch notes");
  });

  it("tags a read-only block with [readonly]", async () => {
    const s = session({ blocks: [{ label: "docs", provider: readOnlyProvider("fixed") }] });
    const prompt = await s.freezeSystemPrompt();
    expect(prompt).toContain("[readonly]");
  });

  it("tags a block with maxTokens with a usage line instead of [readonly]", async () => {
    const s = session({ blocks: [{ label: "notes", maxTokens: 100, provider: writableProvider("hi") }] });
    const prompt = await s.freezeSystemPrompt();
    expect(prompt).toMatch(/\[\d+% — \d+\/100 tokens\]/);
    expect(prompt).not.toContain("[readonly]");
  });

  it("a writable block with no maxTokens gets no tag", async () => {
    const s = session({ blocks: [{ label: "notes", provider: writableProvider("hi") }] });
    const prompt = await s.freezeSystemPrompt();
    expect(prompt).not.toContain("[readonly]");
    expect(prompt).not.toMatch(/\[\d+%/);
  });

  it("freezeSystemPrompt caches; later block writes do not change the frozen value until refreshed", async () => {
    const provider = writableProvider("v1");
    const s = session({ blocks: [{ label: "notes", provider }] });
    const first = await s.freezeSystemPrompt();
    expect(first).toContain("v1");

    await provider.set!("v2");
    const second = await s.freezeSystemPrompt();
    expect(second).toBe(first);
    expect(second).toContain("v1");

    const refreshed = await s.refreshSystemPrompt();
    expect(refreshed).toContain("v2");
    expect(refreshed).not.toBe(first);

    // Now frozen returns the refreshed value.
    const third = await s.freezeSystemPrompt();
    expect(third).toBe(refreshed);
  });

  it("the frozen prompt survives session recreation over the same KV store", async () => {
    const store = createMemoryKeyValueStore();
    const s1 = session({ sessionId: "s1", blocks: [{ label: "notes", provider: writableProvider("v1") }] }, store);
    const frozen1 = await s1.freezeSystemPrompt();

    // A fresh session instance over the same store/sessionId, even with a
    // provider that would render differently, returns the cached value.
    const s2 = session({ sessionId: "s1", blocks: [{ label: "notes", provider: writableProvider("v2") }] }, store);
    const frozen2 = await s2.freezeSystemPrompt();
    expect(frozen2).toBe(frozen1);
  });
});

describe("createSession: context tools", () => {
  it("set_context replace/append write to the provider and report usage", async () => {
    const s = session({ blocks: [{ label: "notes", maxTokens: 1000, provider: writableProvider("") }] });
    const tools = await s.tools();
    const result1 = await tools.set_context!.execute!({ label: "notes", content: "hello", action: "replace" }, ctx());
    expect(result1).toMatch(/^Written to notes\. Usage: \d+% \(\d+\/1000 tokens\)$/);
    expect((await s.getContextBlock("notes"))?.content).toBe("hello");

    await tools.set_context!.execute!({ label: "notes", content: " world", action: "append" }, ctx());
    expect((await s.getContextBlock("notes"))?.content).toBe("hello world");
  });

  it("set_context rejects writes that would exceed maxTokens, without writing", async () => {
    const provider = writableProvider("");
    const s = session({ blocks: [{ label: "notes", maxTokens: 1, provider }] });
    const tools = await s.tools();
    const result = await tools.set_context!.execute!(
      { label: "notes", content: "way more than one token of text", action: "replace" },
      ctx()
    );
    expect(result).toContain("Rejected");
    expect((await s.getContextBlock("notes"))?.content).toBe("");
  });

  it("load_context returns provider content as the tool output", async () => {
    const s = session({ blocks: [{ label: "skills", provider: skillProvider({ recipe: "flour, water" }) }] });
    const tools = await s.tools();
    const result = await tools.load_context!.execute!({ label: "skills", key: "recipe" }, ctx());
    expect(result).toBe("flour, water");
  });

  it("load_context reports not found for an unknown key", async () => {
    const s = session({ blocks: [{ label: "skills", provider: skillProvider({}) }] });
    const tools = await s.tools();
    const result = await tools.load_context!.execute!({ label: "skills", key: "nope" }, ctx());
    expect(result).toContain("Not found");
  });

  it("search_context returns up to 10 results, or a not-found message", async () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ key: `k${i}`, excerpt: `excerpt ${i}`, body: "match" }));
    const s = session({ blocks: [{ label: "kb", provider: searchProvider(items) }] });
    const tools = await s.tools();

    const results = await tools.search_context!.execute!({ label: "kb", query: "match" }, ctx());
    expect((results as string).split("\n").length).toBe(10);

    const empty = await tools.search_context!.execute!({ label: "kb", query: "nothing-matches-this" }, ctx());
    expect(empty).toBe("No results found.");
  });

  it("reconstructs loaded-skill state from history and lists it in tool descriptions", async () => {
    const s = session({ blocks: [{ label: "skills", provider: skillProvider({ recipe: "flour" }) }] });
    const tools1 = await s.tools();
    expect(tools1.load_context!.description).toContain("Currently loaded: none");

    // Simulate the turn loop appending the settled tool call.
    await s.appendMessage(
      assistantMessage(
        [
          {
            type: "tool-load_context",
            toolCallId: "call_1",
            state: "output-available",
            input: { label: "skills", key: "recipe" },
            output: "flour",
          },
        ],
        "a1"
      )
    );

    const tools2 = await s.tools();
    expect(tools2.load_context!.description).toContain("skills:recipe");
    expect(tools2.unload_context!.description).toContain("skills:recipe");
  });

  it("unload_context rewrites the original load_context tool output in history and untracks the key", async () => {
    const s = session({ blocks: [{ label: "skills", provider: skillProvider({ recipe: "flour" }) }] });
    await s.appendMessage(
      assistantMessage(
        [
          {
            type: "tool-load_context",
            toolCallId: "call_1",
            state: "output-available",
            input: { label: "skills", key: "recipe" },
            output: "flour",
          },
        ],
        "a1"
      )
    );

    const tools = await s.tools();
    expect(tools.load_context!.description).toContain("skills:recipe");

    const result = await tools.unload_context!.execute!({ label: "skills", key: "recipe" }, ctx());
    expect(result).toContain("Unloaded");

    const history = await s.getHistory();
    const rewritten = toolPartOf(history.find((m) => m.id === "a1")!);
    expect(rewritten.output).toBe("[skill unloaded: recipe]");

    const toolsAfter = await s.tools();
    expect(toolsAfter.load_context!.description).toContain("Currently loaded: none");
  });

  it("unload_context on a key that isn't loaded reports as such", async () => {
    const s = session({ blocks: [{ label: "skills", provider: skillProvider({ recipe: "flour" }) }] });
    const tools = await s.tools();
    const result = await tools.unload_context!.execute!({ label: "skills", key: "recipe" }, ctx());
    expect(result).toContain("Not currently loaded");
  });
});

describe("createSession: compaction orchestration", () => {
  it("compact() plans, summarizes, and stores an overlay reflected in getHistory", async () => {
    let capturedPrompt: string | undefined;
    const s = session({
      blocks: [],
      compaction: {
        summarize: async (prompt) => {
          capturedPrompt = prompt;
          return "SUMMARY";
        },
        protectHead: 1,
        tailTokenBudget: 1,
        minTailMessages: 1,
      },
    });

    for (let i = 0; i < 10; i++) {
      await s.appendMessage(userMessage(`message number ${i} `.repeat(20), `m${i}`));
    }

    const result = await s.compact();
    expect(result.compacted).toBe(true);
    expect(result.summaryId).toBeDefined();
    expect(capturedPrompt).toContain("Summarize the following");

    const history = await s.getHistory();
    // A synthetic summary message now stands in for the compacted range.
    expect(history.some((m) => m.id.startsWith("compaction_"))).toBe(true);
    expect(history.length).toBeLessThan(10);
    const summaryMsg = history.find((m) => m.id.startsWith("compaction_"))!;
    expect(summaryMsg.parts).toEqual([{ type: "text", text: "SUMMARY" }]);
  });

  it("compact() returns compacted:false when there is nothing worth compacting", async () => {
    const s = session({
      blocks: [],
      compaction: { summarize: async () => "SUMMARY", protectHead: 5, minTailMessages: 5 },
    });
    await s.appendMessage(userMessage("hi", "m1"));
    const result = await s.compact();
    expect(result.compacted).toBe(false);
  });

  it("compact() returns compacted:false and calls onCompactionError when summarize throws, without losing messages", async () => {
    const errors: unknown[] = [];
    const s = session({
      blocks: [],
      compaction: {
        summarize: async () => {
          throw new Error("model unavailable");
        },
        protectHead: 1,
        tailTokenBudget: 1,
        minTailMessages: 1,
      },
      onCompactionError: (e) => errors.push(e),
    });
    for (let i = 0; i < 10; i++) {
      await s.appendMessage(userMessage(`message number ${i} `.repeat(20), `m${i}`));
    }

    const result = await s.compact();
    expect(result.compacted).toBe(false);
    expect(errors.length).toBe(1);
    expect((await s.getHistory()).length).toBe(10);
  });

  it("auto-compacts after appendMessage once history exceeds compactAfterTokens, and reports status", async () => {
    const statuses: Array<{ phase: string; tokenEstimate: number }> = [];
    const s = session({
      blocks: [],
      compaction: {
        summarize: async () => "auto-summary",
        protectHead: 1,
        tailTokenBudget: 1,
        minTailMessages: 1,
        compactAfterTokens: 20,
      },
      onStatus: (status) => statuses.push(status),
    });

    for (let i = 0; i < 10; i++) {
      await s.appendMessage(userMessage(`message number ${i} `.repeat(20), `m${i}`));
    }

    // At least one status transitioned through "compacting".
    expect(statuses.some((st) => st.phase === "compacting")).toBe(true);
    expect(statuses[statuses.length - 1]!.phase).toBe("idle");

    const history = await s.getHistory();
    expect(history.some((m) => m.id.startsWith("compaction_"))).toBe(true);
  });

  it("swallows auto-compaction errors: appendMessage still resolves and messages are preserved", async () => {
    const errors: unknown[] = [];
    const s = session({
      blocks: [],
      compaction: {
        summarize: async () => {
          throw new Error("boom");
        },
        protectHead: 1,
        tailTokenBudget: 1,
        minTailMessages: 1,
        compactAfterTokens: 20,
      },
      onCompactionError: (e) => errors.push(e),
    });

    for (let i = 0; i < 10; i++) {
      await s.appendMessage(userMessage(`message number ${i} `.repeat(20), `m${i}`));
    }

    expect(errors.length).toBeGreaterThan(0);
    expect((await s.getHistory()).length).toBe(10);
  });

  it("iterative re-compaction passes the previous overlay summary back into the prompt", async () => {
    const prompts: string[] = [];
    const s = session({
      blocks: [],
      compaction: {
        summarize: async (prompt) => {
          prompts.push(prompt);
          return `summary-${prompts.length}`;
        },
        protectHead: 1,
        tailTokenBudget: 1,
        minTailMessages: 1,
      },
    });

    for (let i = 0; i < 6; i++) {
      await s.appendMessage(userMessage(`message number ${i} `.repeat(20), `m${i}`));
    }
    const first = await s.compact();
    expect(first.compacted).toBe(true);

    for (let i = 6; i < 12; i++) {
      await s.appendMessage(userMessage(`message number ${i} `.repeat(20), `m${i}`));
    }
    const second = await s.compact();
    expect(second.compacted).toBe(true);
    expect(second.summaryId).not.toBe(first.summaryId);

    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("Existing summary of earlier context");
    expect(prompts[1]).toContain("summary-1");

    // Only one overlay message should remain covering the extended range.
    const history = await s.getHistory();
    expect(history.filter((m) => m.id.startsWith("compaction_")).length).toBe(1);
  });
});

function ctx() {
  return { toolCallId: "call_x", requestId: "req_x", messages: [], signal: new AbortController().signal };
}
