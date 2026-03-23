import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { describe, expect, it, beforeEach } from "vitest";
import { getAgentByName } from "../../../..";

/**
 * Typed stub for TestSessionAgent (tree-structured Session API)
 */
interface SessionAgentStub {
  appendMessage(message: UIMessage, parentId?: string): Promise<void>;
  getMessage(id: string): Promise<UIMessage | null>;
  updateMessage(message: UIMessage): Promise<void>;
  deleteMessages(ids: string[]): Promise<void>;
  clearMessages(): Promise<void>;
  getHistory(leafId?: string): Promise<UIMessage[]>;
  getLatestLeaf(): Promise<UIMessage | null>;
  getBranches(messageId: string): Promise<UIMessage[]>;
  getPathLength(): Promise<number>;
  addCompaction(summary: string, fromId: string, toId: string): Promise<unknown>;
  getCompactions(): Promise<unknown[]>;
  needsCompaction(max?: number): Promise<boolean>;
  search(query: string): Promise<Array<{ id: string; role: string; content: string }>>;
}

async function getAgent(name: string): Promise<SessionAgentStub> {
  return getAgentByName(env.TestSessionAgent, name) as unknown as Promise<SessionAgentStub>;
}

describe("AgentSessionProvider — tree-structured messages", () => {
  let name: string;
  beforeEach(() => {
    name = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it("starts with empty history", async () => {
    const agent = await getAgent(name);
    const history = await agent.getHistory();
    expect(history).toEqual([]);
  });

  it("append and retrieve messages", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }] });
    await agent.appendMessage({ id: "m2", role: "assistant", parts: [{ type: "text", text: "Hi" }] });

    const history = await agent.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe("m1");
    expect(history[1].id).toBe("m2");
  });

  it("getMessage by ID", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }] });

    const msg = await agent.getMessage("m1");
    expect(msg?.id).toBe("m1");

    const missing = await agent.getMessage("nope");
    expect(missing).toBeNull();
  });

  it("tree structure — parentId links messages", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "Root" }] });
    await agent.appendMessage({ id: "m2", role: "assistant", parts: [{ type: "text", text: "Reply" }] });

    const history = await agent.getHistory();
    expect(history.map(m => m.id)).toEqual(["m1", "m2"]);
    expect(await agent.getPathLength()).toBe(2);
  });

  it("branching — multiple children of same parent", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "Question" }] });
    // Two branches from m1
    await agent.appendMessage({ id: "m2a", role: "assistant", parts: [{ type: "text", text: "Answer A" }] }, "m1");
    await agent.appendMessage({ id: "m2b", role: "assistant", parts: [{ type: "text", text: "Answer B" }] }, "m1");

    const branches = await agent.getBranches("m1");
    expect(branches).toHaveLength(2);
    expect(branches.map(m => m.id).sort()).toEqual(["m2a", "m2b"]);

    // Latest leaf is m2b (most recent)
    const leaf = await agent.getLatestLeaf();
    expect(leaf?.id).toBe("m2b");

    // getHistory from m2a branch
    const historyA = await agent.getHistory("m2a");
    expect(historyA.map(m => m.id)).toEqual(["m1", "m2a"]);

    // getHistory from m2b branch
    const historyB = await agent.getHistory("m2b");
    expect(historyB.map(m => m.id)).toEqual(["m1", "m2b"]);
  });

  it("updateMessage", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "Original" }] });
    await agent.updateMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "Updated" }] });

    const msg = await agent.getMessage("m1");
    expect(msg?.parts[0]).toEqual({ type: "text", text: "Updated" });
  });

  it("clearMessages", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] });
    await agent.clearMessages();

    expect(await agent.getHistory()).toEqual([]);
    expect(await agent.getPathLength()).toBe(0);
  });

  it("idempotent append — same ID is no-op", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "First" }] });
    await agent.appendMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "Duplicate" }] });

    const history = await agent.getHistory();
    expect(history).toHaveLength(1);
    // INSERT OR IGNORE — keeps the first
    expect(history[0].parts[0]).toEqual({ type: "text", text: "First" });
  });

  it("needsCompaction threshold", async () => {
    const agent = await getAgent(name);
    for (let i = 0; i < 5; i++) {
      await agent.appendMessage({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", parts: [{ type: "text", text: `msg ${i}` }] });
    }

    expect(await agent.needsCompaction(10)).toBe(false);
    expect(await agent.needsCompaction(3)).toBe(true);
  });

  it("compaction overlays — addCompaction replaces range in getHistory", async () => {
    const agent = await getAgent(name);
    for (let i = 0; i < 6; i++) {
      await agent.appendMessage({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", parts: [{ type: "text", text: `msg ${i}` }] });
    }

    // Compact middle messages (m1-m3)
    await agent.addCompaction("Summary of m1-m3", "m1", "m3");

    const history = await agent.getHistory();
    // m0 + compaction_summary + m4 + m5
    expect(history).toHaveLength(4);
    expect(history[0].id).toBe("m0");
    expect(history[1].id).toMatch(/^compaction_/);
    expect(history[1].parts[0]).toEqual({ type: "text", text: expect.stringContaining("Summary of m1-m3") });
    expect(history[2].id).toBe("m4");
    expect(history[3].id).toBe("m5");

    // Compactions are stored
    const compactions = await agent.getCompactions();
    expect(compactions).toHaveLength(1);
  });

  it("FTS search", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "I love TypeScript" }] });
    await agent.appendMessage({ id: "m2", role: "assistant", parts: [{ type: "text", text: "Great choice" }] });
    await agent.appendMessage({ id: "m3", role: "user", parts: [{ type: "text", text: "Python is also good" }] });

    const results = await agent.search("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("TypeScript");
  });

  it("persistence across agent lookups", async () => {
    const agent1 = await getAgent(name);
    await agent1.appendMessage({ id: "m1", role: "user", parts: [{ type: "text", text: "Hello" }] });

    const agent2 = await getAgent(name);
    const history = await agent2.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe("m1");
  });
});
