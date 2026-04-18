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

  it("forwards the AI SDK's full StepResult — text and usage", async () => {
    // Regression for #1339 — ctx should expose the full AI SDK StepResult,
    // not a hand-picked subset. Verify text and the real usage fields make
    // it through (mock model emits "Hello from the assistant!" with
    // inputTokens=10, outputTokens=5).
    const agent = await freshAgent("hook-sf-shape");
    await agent.setResponse("Hello from the assistant!");
    await agent.testChat("Hello");

    const log = await agent.getStepLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].text).toBe("Hello from the assistant!");
    expect(log[0].inputTokens).toBe(10);
    expect(log[0].outputTokens).toBe(5);
  });

  it("forwards typed toolCalls/toolResults arrays", async () => {
    // The mock tool model emits one `echo` tool call and the loop
    // continues until the model produces final text. Verify both the
    // tool-call step and the final step are observed.
    const agent = await freshLoopToolAgent("hook-sf-tools");
    await agent.testChat("Use echo");

    const log = await agent.getStepLog();
    expect(log.length).toBeGreaterThanOrEqual(2);
    const toolStep = log.find((s) => s.toolCallCount > 0);
    expect(toolStep).toBeDefined();
    expect(toolStep!.toolResultCount).toBeGreaterThan(0);
  });
});

// ── beforeToolCall / afterToolCall ──────────────────────────────

describe("Think — tool-call hooks expose typed input/output", () => {
  it("beforeToolCall receives toolName and typed input", async () => {
    // Regression for #1339 — ctx.input was always {} because the wrapper
    // read tc.args (AI SDK uses .input). Verify the real input flows.
    const agent = await freshLoopToolAgent("hook-tc-input");
    await agent.testChat("Use echo");

    const log = await agent.getBeforeToolCallLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].toolName).toBe("echo");
    expect(JSON.parse(log[0].inputJson)).toEqual({ message: "ping" });
  });

  it("afterToolCall receives typed output (was always undefined before)", async () => {
    const agent = await freshLoopToolAgent("hook-tc-output");
    await agent.testChat("Use echo");

    const log = await agent.getAfterToolCallLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].toolName).toBe("echo");
    expect(JSON.parse(log[0].inputJson)).toEqual({ message: "ping" });
    // Mock tool returns "pong: ping"
    expect(JSON.parse(log[0].outputJson)).toBe("pong: ping");
  });
});

// ── ToolCallDecision (block / substitute / allow-with-input) ────

describe("Think — ToolCallDecision honored by wrapped execute", () => {
  it("void decision runs the original execute with original input", async () => {
    const agent = await freshToolAgent("dec-default");
    await agent.setToolCallDecision(null);
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].toolName).toBe("echo");
    expect(JSON.parse(after[0].inputJson)).toEqual({ message: "hello" });
    // Real tool returned "echo: hello"
    expect(JSON.parse(after[0].outputJson)).toBe("echo: hello");
  });

  it("'allow' with modified input runs execute with the substituted input", async () => {
    const agent = await freshToolAgent("dec-allow-input");
    await agent.setToolCallDecision({
      action: "allow",
      input: { message: "rewritten" }
    });
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    // `afterToolCall.input` reflects what the *model* emitted (the
    // AI SDK records the original tool-call chunk), while `output`
    // reflects the result of executing with the substituted input.
    expect(JSON.parse(after[0].inputJson)).toEqual({ message: "hello" });
    expect(JSON.parse(after[0].outputJson)).toBe("echo: rewritten");
  });

  it("'block' short-circuits execute and returns reason as the result", async () => {
    const agent = await freshToolAgent("dec-block");
    await agent.setToolCallDecision({
      action: "block",
      reason: "not allowed in this context"
    });
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    // afterToolCall fires with success=true (block is a successful
    // outcome from the model's perspective — it gets a string back)
    // and the reason as output.
    expect(JSON.parse(after[0].outputJson)).toBe("not allowed in this context");
  });

  it("'block' with no reason returns a default string", async () => {
    const agent = await freshToolAgent("dec-block-default");
    await agent.setToolCallDecision({ action: "block" });
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(JSON.parse(after[0].outputJson)).toContain("blocked");
  });

  it("'substitute' short-circuits execute and returns the substituted output", async () => {
    const agent = await freshToolAgent("dec-substitute");
    await agent.setToolCallDecision({
      action: "substitute",
      output: { fake: "value", reason: "cached" }
    });
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(JSON.parse(after[0].outputJson)).toEqual({
      fake: "value",
      reason: "cached"
    });
  });

  it("async beforeToolCall (Promise<ToolCallDecision>) is awaited correctly", async () => {
    // Verify the wrapper's `await this.beforeToolCall(ctx)` actually
    // waits for an async hook to resolve before deciding what to do.
    const agent = await freshToolAgent("dec-async");
    await agent.setBeforeToolCallAsync(true);
    await agent.setToolCallDecision({
      action: "substitute",
      output: "from async hook"
    });
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    expect(JSON.parse(after[0].outputJson)).toBe("from async hook");
  });

  it("a throwing beforeToolCall surfaces as a tool error in afterToolCall", async () => {
    // A subclass that throws from `beforeToolCall` should be observably
    // equivalent to `execute` throwing — i.e. the AI SDK catches it and
    // emits a tool-error, which `afterToolCall` sees as `success: false`.
    const agent = await freshToolAgent("dec-throw");
    await agent.setBeforeToolCallThrows("policy violation");
    await agent.testChat("call echo");

    const after = await agent.getAfterToolCallLog();
    expect(after.length).toBeGreaterThan(0);
    const parsed = JSON.parse(after[0].outputJson) as { error: string };
    expect(parsed.error).toContain("policy violation");
  });
});

// ── Extension hook dispatch ─────────────────────────────────────

async function freshExtensionHookAgent(name: string) {
  return getAgentByName(env.ThinkExtensionHookAgent, name);
}

describe("Think — extension observation hooks", () => {
  it("dispatches beforeToolCall to extension subscribers", async () => {
    // Regression for the gap where ExtensionManifest.hooks accepted
    // beforeToolCall/afterToolCall/onStepFinish/onChunk but Think only
    // ever fired beforeTurn. The extension records each hook into a
    // workspace marker file via the host bridge.
    const agent = await freshExtensionHookAgent("ext-before-tc");
    await agent.testChat("ping");

    const files = await agent.listExtLogFiles();
    expect(files).toContain("before-ping.json");

    const recorded = (await agent.readExtLogFile("before-ping.json")) as {
      toolName: string;
      input: unknown;
      stepNumber: number;
    } | null;
    expect(recorded).not.toBeNull();
    expect(recorded!.toolName).toBe("ping");
    expect(recorded!.input).toEqual({ msg: "hi" });
  });

  it("dispatches afterToolCall with success/output and durationMs", async () => {
    const agent = await freshExtensionHookAgent("ext-after-tc");
    await agent.testChat("ping");

    const recorded = (await agent.readExtLogFile("after-ping.json")) as {
      toolName: string;
      success: boolean;
      output: unknown;
      durationMs: number;
    } | null;
    expect(recorded).not.toBeNull();
    expect(recorded!.toolName).toBe("ping");
    expect(recorded!.success).toBe(true);
    expect(recorded!.output).toBe("pong: hi");
    expect(typeof recorded!.durationMs).toBe("number");
  });

  it("dispatches onStepFinish to extension subscribers", async () => {
    const agent = await freshExtensionHookAgent("ext-step-finish");
    await agent.testChat("ping");

    // Two steps: one with the tool call, one with the final text.
    const files = await agent.listExtLogFiles();
    const stepFiles = files.filter((f) => f.startsWith("step-"));
    expect(stepFiles.length).toBeGreaterThanOrEqual(1);

    const first = (await agent.readExtLogFile(stepFiles[0])) as {
      stepNumber: number;
      finishReason: string;
      usage: { inputTokens?: number; outputTokens?: number };
    } | null;
    expect(first).not.toBeNull();
    expect(typeof first!.stepNumber).toBe("number");
    expect(typeof first!.finishReason).toBe("string");
  });

  it("dispatches onChunk to extension subscribers", async () => {
    const agent = await freshExtensionHookAgent("ext-on-chunk");
    await agent.testChat("ping");

    const files = await agent.listExtLogFiles();
    const chunkFiles = files.filter((f) => f.startsWith("chunk-"));
    expect(chunkFiles.length).toBeGreaterThan(0);

    // We expect at least a text-delta chunk from the final-step text.
    const recorded = (await agent.readExtLogFile("chunk-text-delta.json")) as {
      type: string;
      text?: string;
    } | null;
    expect(recorded).not.toBeNull();
    expect(recorded!.type).toBe("text-delta");
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

  it("_hostDeleteFile removes a file", async () => {
    const agent = await freshAgent("host-del");
    await agent.hostWriteFile("temp.txt", "delete me");
    const deleted = await agent.hostDeleteFile("temp.txt");
    expect(deleted).toBe(true);
    const content = await agent.hostReadFile("temp.txt");
    expect(content).toBeNull();
  });

  it("_hostDeleteFile returns false for missing file", async () => {
    const agent = await freshAgent("host-del-miss");
    const deleted = await agent.hostDeleteFile("nope.txt");
    expect(deleted).toBe(false);
  });

  it("_hostListFiles lists directory contents", async () => {
    const agent = await freshAgent("host-list");
    await agent.hostWriteFile("dir/a.txt", "aaa");
    await agent.hostWriteFile("dir/b.txt", "bbb");
    const entries = await agent.hostListFiles("dir");
    const names = entries.map((e: { name: string }) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("_hostGetMessages with limit=0 returns empty array", async () => {
    const agent = await freshAgent("host-limit0");
    await agent.testChat("Hello");
    const messages = await agent.hostGetMessages(0);
    expect(messages).toEqual([]);
  });

  it("_hostSendMessage injects a user message", async () => {
    const agent = await freshAgent("host-send");
    await agent.testChat("First");
    await agent.hostSendMessage("Injected message");

    const messages = await agent.hostGetMessages();
    const texts = messages.map((m: { content: string }) => m.content);
    expect(texts).toContain("Injected message");
  });
});

// ── beforeTurn TurnConfig overrides ─────────────────────────────

describe("Think — beforeTurn config overrides", () => {
  it("maxSteps override is applied per-turn", async () => {
    const agent = await freshAgent("bt-maxsteps");
    await agent.setTurnConfigOverride({ maxSteps: 1 });
    const result = await agent.testChat("Hello");
    expect(result.done).toBe(true);
  });

  it("beforeTurn still sees original system prompt when override is set", async () => {
    const agent = await freshAgent("bt-system");
    await agent.setTurnConfigOverride({ system: "You are a pirate." });
    await agent.testChat("With override");

    const log = await agent.getBeforeTurnLog();
    expect(log[0].system).toBe("You are a helpful assistant.");
  });

  it("activeTools override limits tool availability", async () => {
    const agent = await freshAgent("bt-active");
    await agent.setTurnConfigOverride({ activeTools: ["read"] });
    const result = await agent.testChat("Restricted tools");
    expect(result.done).toBe(true);
  });
});
