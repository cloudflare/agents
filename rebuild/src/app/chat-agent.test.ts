import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryHost, type MemoryHost } from "../adapters/memory/host.js";
import { createFakeModel, type FakeModel, type FakeTurn } from "../adapters/memory/fake-model.js";
import type { IdSource } from "../kernel/ids.js";
import type { ModelClient } from "../ports/model.js";
import type { ToolSet } from "../domain/tools/types.js";
import type { AgentHost } from "./agent.js";
import { ChatAgent } from "./chat-agent.js";

// ---------------------------------------------------------------------------
// Test helpers (mirrors think.test.ts's — proves the essence layer works
// with zero opinion services composed).
// ---------------------------------------------------------------------------

function counterIds(): IdSource {
  let n = 0;
  return { newId: (prefix: string) => `${prefix}_${++n}` };
}

function toHost(mem: MemoryHost, opts: Partial<AgentHost> & { className: string; name: string }): AgentHost {
  return {
    store: mem.store,
    alarm: mem.alarms,
    clock: mem.clock,
    ids: counterIds(),
    ...opts,
  };
}

/** Flexible bare-ChatAgent subclass: no opinions composed at all. */
class TestChatAgent extends ChatAgent<unknown> {
  model!: ModelClient;
  tools: ToolSet = {};
  systemPrompt = "You are a test assistant.";

  protected override getModel(): ModelClient {
    return this.model;
  }
  protected override getSystemPrompt(): string {
    return this.systemPrompt;
  }
  protected override getTools(): ToolSet {
    return this.tools;
  }
}

function makeChatAgent(script: FakeTurn[]): { agent: TestChatAgent; mem: MemoryHost; model: FakeModel } {
  const mem = createMemoryHost({ agent: "TestChatAgent", name: "a1" });
  const host = toHost(mem, { className: "TestChatAgent", name: "a1" });
  const agent = new TestChatAgent(host);
  mem.attachAgent(agent);
  const model = createFakeModel(script);
  agent.model = model;
  return { agent, mem, model };
}

// ---------------------------------------------------------------------------
// chat() end-to-end, with zero opinion services composed
// ---------------------------------------------------------------------------

describe("ChatAgent — bare essence layer (no opinions composed)", () => {
  it("chat() runs a text turn end-to-end and persists the transcript", async () => {
    const { agent } = makeChatAgent([{ kind: "text", text: "Hello from the essence layer" }]);
    await agent.start();

    const result = await agent.chat("Hi", undefined, { requestId: "req_1" });
    expect(result.outcome).toBe("completed");

    const messages = await agent.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    const text = messages[1]!.parts.find((p) => p.type === "text");
    expect(text).toMatchObject({ text: "Hello from the essence layer" });
  });

  it("history() replays the repaired transcript", async () => {
    const { agent } = makeChatAgent([{ kind: "text", text: "hi there" }]);
    await agent.start();
    await agent.chat("Hi", undefined, { requestId: "req_1" });

    const history = await agent.history();
    expect(history).toHaveLength(2);
  });

  it("clearMessages() empties history and is a no-op beyond the essence bookkeeping (no submissions opinion to notify)", async () => {
    const { agent } = makeChatAgent([{ kind: "text", text: "hi" }]);
    await agent.start();
    await agent.chat("Hi", undefined, { requestId: "req_1" });
    expect(await agent.getMessages()).toHaveLength(2);

    await agent.clearMessages();
    expect(await agent.getMessages()).toHaveLength(0);
  });

  it("applyToolResult() delivers a client tool's output and auto-continues the turn", async () => {
    const { agent } = makeChatAgent([
      { kind: "tool-call", toolName: "add", input: { a: 2, b: 3 }, id: "call_1" },
      { kind: "text", text: "Sum is 5" },
    ]);
    agent.tools = {
      add: { description: "adds numbers", inputSchema: z.object({ a: z.number(), b: z.number() }) },
    };
    agent.chatToolResultDebounceMs = 0;
    await agent.start();

    await agent.chat("add 2 and 3", undefined, { requestId: "req_1" });
    let messages = await agent.getMessages();
    expect(messages[1]!.parts.find((p) => p.type === "tool-add")).toMatchObject({ state: "input-available" });

    await agent.applyToolResult({ toolCallId: "call_1", output: 5 });
    await vi.waitFor(async () => {
      messages = await agent.getMessages();
      expect(messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "Sum is 5"))).toBe(true);
    });
  });

  it("waitUntilStable() returns true once the (recovery-free, action-free) turn queue is idle", async () => {
    const { agent } = makeChatAgent([{ kind: "text", text: "done" }]);
    await agent.start();
    await agent.chat("hi", undefined, { requestId: "req_1" });
    expect(await agent.waitUntilStable({ timeoutMs: 50 })).toBe(true);
  });

  it("runTurn({ mode: 'submit' }) throws on a bare ChatAgent (no SubmissionService composed)", async () => {
    const { agent } = makeChatAgent([]);
    await agent.start();
    await expect(agent.runTurn({ input: "hi", mode: "submit" })).rejects.toThrow(/submissions are not supported/i);
  });
});
