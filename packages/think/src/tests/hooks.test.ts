import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";

async function freshAgent(name: string) {
  return getAgentByName(env.ThinkTestAgent, name);
}

async function freshProgrammaticAgent(name: string) {
  return getAgentByName(env.ThinkProgrammaticTestAgent, name);
}

async function freshToolAgent(name: string) {
  return getAgentByName(env.ThinkToolsTestAgent, name);
}

async function freshLoopToolAgent(name: string) {
  return getAgentByName(env.LoopToolTestAgent, name);
}

// ── beforeTurn ──────────────────────────────────────────────────

describe("Think — beforeTurn hook", () => {
  it("receives correct TurnContext with system prompt and tools", async () => {
    const agent = await freshAgent("hook-bt-ctx");
    await agent.testChat("Hello");

    const log = await agent.getBeforeTurnLog();
    expect(log).toHaveLength(1);
    expect(log[0].system).toBe("You are a helpful assistant.");
    expect(log[0].continuation).toBe(false);
    expect(log[0].toolNames).toContain("read");
    expect(log[0].toolNames).toContain("write");
  });

  it("fires on every turn", async () => {
    const agent = await freshAgent("hook-bt-multi");
    await agent.testChat("First");
    await agent.testChat("Second");

    const log = await agent.getBeforeTurnLog();
    expect(log).toHaveLength(2);
  });

  it("fires from chat() sub-agent path", async () => {
    const agent = await freshAgent("hook-bt-chat");
    await agent.testChat("Via chat()");

    const log = await agent.getBeforeTurnLog();
    expect(log).toHaveLength(1);
    expect(log[0].continuation).toBe(false);
  });

  it("captures continuation flag from programmatic path", async () => {
    const agent = await freshProgrammaticAgent("hook-bt-save");
    await agent.testChat("First message");
    const opts = await agent.getCapturedOptions();
    expect(opts).toHaveLength(1);
    expect(opts[0].continuation).toBe(false);
  });
});

// ── onStepFinish ────────────────────────────────────────────────

describe("Think — onStepFinish hook", () => {
  it("fires after step completes with correct data", async () => {
    const agent = await freshAgent("hook-sf-1");
    await agent.testChat("Hello");

    const log = await agent.getStepLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].finishReason).toBe("stop");
  });
});

// ── onChunk ─────────────────────────────────────────────────────

describe("Think — onChunk hook", () => {
  it("fires for streaming chunks", async () => {
    const agent = await freshAgent("hook-chunk-1");
    await agent.testChat("Hello");

    const count = await agent.getChunkCount();
    expect(count).toBeGreaterThan(0);
  });
});

// ── maxSteps property ───────────────────────────────────────────

describe("Think — maxSteps property", () => {
  it("respects maxSteps override on class", async () => {
    const agent = await freshToolAgent("hook-maxsteps");
    const result = await agent.testChat("Test");
    expect(result.done).toBe(true);
  });

  it("works with tool-calling loop agent", async () => {
    const agent = await freshLoopToolAgent("hook-loop-ms");
    const messages = agent.getMessages();
    expect(messages).toBeDefined();
  });
});

// ── Convergence: hooks fire from all entry paths ────────────────

describe("Think — hook convergence", () => {
  it("beforeTurn fires from chat() RPC path", async () => {
    const agent = await freshAgent("hook-conv-chat");
    await agent.testChat("From chat");

    const log = await agent.getBeforeTurnLog();
    expect(log).toHaveLength(1);
  });

  it("beforeTurn fires from saveMessages path", async () => {
    const agent = await freshProgrammaticAgent("hook-conv-save");
    await agent.testSaveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "From saveMessages" }]
      }
    ]);

    const opts = await agent.getCapturedOptions();
    expect(opts).toHaveLength(1);
  });
});

// ── Dynamic context (Phase 2) ───────────────────────────────────

async function freshSessionAgent(name: string) {
  return getAgentByName(env.ThinkSessionTestAgent, name);
}

describe("Think — dynamic context", () => {
  it("addContext registers a new block", async () => {
    const agent = await freshSessionAgent("dctx-add");
    await agent.addDynamicContext("notes", "User notes");

    const labels = await agent.getContextLabels();
    expect(labels).toContain("memory");
    expect(labels).toContain("notes");
  });

  it("addContext block appears in system prompt after refresh", async () => {
    const agent = await freshSessionAgent("dctx-prompt");
    await agent.addDynamicContext("extra", "Extra context block");
    await agent.setContextBlock("extra", "Some important content");
    const prompt = await agent.refreshPrompt();

    expect(prompt).toContain("EXTRA");
    expect(prompt).toContain("Some important content");
  });

  it("removeContext removes the block", async () => {
    const agent = await freshSessionAgent("dctx-remove");
    await agent.addDynamicContext("temp", "Temporary block");

    let labels = await agent.getContextLabels();
    expect(labels).toContain("temp");

    const removed = await agent.removeDynamicContext("temp");
    expect(removed).toBe(true);

    labels = await agent.getContextLabels();
    expect(labels).not.toContain("temp");
  });

  it("removeContext returns false for non-existent block", async () => {
    const agent = await freshSessionAgent("dctx-remove-none");
    const removed = await agent.removeDynamicContext("nonexistent");
    expect(removed).toBe(false);
  });

  it("removed block disappears from system prompt after refresh", async () => {
    const agent = await freshSessionAgent("dctx-remove-prompt");
    await agent.addDynamicContext("ephemeral", "Gone soon");
    await agent.setContextBlock("ephemeral", "Temporary data");
    await agent.refreshPrompt();

    let prompt = await agent.getSystemPromptSnapshot();
    expect(prompt).toContain("EPHEMERAL");

    await agent.removeDynamicContext("ephemeral");
    prompt = await agent.refreshPrompt();
    expect(prompt).not.toContain("EPHEMERAL");
  });

  it("dynamic block is writable by default", async () => {
    const agent = await freshSessionAgent("dctx-writable");
    await agent.addDynamicContext("writable_block");

    const details = await agent.getContextBlockDetails("writable_block");
    expect(details).toBeDefined();
    expect(details!.writable).toBe(true);
  });

  it("dynamic block content can be written via setContextBlock", async () => {
    const agent = await freshSessionAgent("dctx-write");
    await agent.addDynamicContext("data", "Stored data");
    await agent.setContextBlock("data", "Hello world");

    const content = await agent.getContextBlockContent("data");
    expect(content).toBe("Hello world");
  });

  it("session tools include set_context after adding writable block", async () => {
    const agent = await freshSessionAgent("dctx-tools");
    await agent.addDynamicContext("notes", "Notes block");

    const toolNames = await agent.getSessionToolNames();
    expect(toolNames).toContain("set_context");
  });

  it("addContext coexists with configureSession blocks", async () => {
    const agent = await freshSessionAgent("dctx-coexist");
    await agent.addDynamicContext("extra", "Extra block");
    await agent.setContextBlock("extra", "Extra content");
    await agent.setContextBlock("memory", "Memory content");
    const prompt = await agent.refreshPrompt();

    expect(prompt).toContain("MEMORY");
    expect(prompt).toContain("EXTRA");
    expect(prompt).toContain("Extra content");
    expect(prompt).toContain("Memory content");
  });

  it("dynamic block visible in chat turn tools", async () => {
    const agent = await freshAgent("dctx-turn");
    await agent.testChat("First turn");

    const log = await agent.getBeforeTurnLog();
    const tools = log[0].toolNames;

    expect(tools).not.toContain("set_context");
  });
});

// ── Host bridge methods (Phase 3) ───────────────────────────────

describe("Think — host bridge methods", () => {
  it("_hostWriteFile and _hostReadFile delegate to workspace", async () => {
    const agent = await freshAgent("host-ws-rw");
    await agent.hostWriteFile("test.txt", "hello world");
    const content = await agent.hostReadFile("test.txt");
    expect(content).toBe("hello world");
  });

  it("_hostReadFile returns null for missing file", async () => {
    const agent = await freshAgent("host-ws-miss");
    const content = await agent.hostReadFile("nonexistent.txt");
    expect(content).toBeNull();
  });

  it("_hostGetMessages returns conversation history", async () => {
    const agent = await freshAgent("host-msgs");
    await agent.testChat("Hello");

    const messages = await agent.hostGetMessages();
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello");
  });

  it("_hostGetMessages respects limit", async () => {
    const agent = await freshAgent("host-msgs-limit");
    await agent.testChat("First");
    await agent.testChat("Second");

    const all = await agent.hostGetMessages();
    const limited = await agent.hostGetMessages(2);
    expect(limited.length).toBe(2);
    expect(limited.length).toBeLessThanOrEqual(all.length);
  });

  it("_hostGetSessionInfo returns message count", async () => {
    const agent = await freshAgent("host-info");
    await agent.testChat("Hello");

    const info = await agent.hostGetSessionInfo();
    expect(info.messageCount).toBeGreaterThanOrEqual(2);
  });

  it("_insideInferenceLoop is false outside a turn", async () => {
    const agent = await freshAgent("host-loop-flag");
    const inside = await agent.isInsideInferenceLoop();
    expect(inside).toBe(false);
  });

  it("_insideInferenceLoop is false after a completed turn", async () => {
    const agent = await freshAgent("host-loop-after");
    await agent.testChat("Hello");
    const inside = await agent.isInsideInferenceLoop();
    expect(inside).toBe(false);
  });

  it("_hostSetContext writes to a context block", async () => {
    const agent = await freshSessionAgent("host-set-ctx");
    await agent.hostSetContext("memory", "Set via host bridge");
    const content = await agent.hostGetContext("memory");
    expect(content).toBe("Set via host bridge");
  });

  it("_hostGetContext returns null for non-existent block", async () => {
    const agent = await freshSessionAgent("host-get-ctx-miss");
    const content = await agent.hostGetContext("nonexistent");
    expect(content).toBeNull();
  });
});
