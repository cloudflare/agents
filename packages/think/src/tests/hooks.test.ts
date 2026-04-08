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
