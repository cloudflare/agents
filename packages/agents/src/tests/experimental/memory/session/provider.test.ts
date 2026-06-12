import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { describe, expect, it, beforeEach } from "vitest";
import { getAgentByName } from "../../../..";

/**
 * Typed stub for TestSessionAgent (tree-structured Session API)
 */
interface SessionAgentStub {
  appendMessage(message: UIMessage, parentId?: string | null): Promise<void>;
  getMessage(id: string): Promise<UIMessage | null>;
  updateMessage(message: UIMessage): Promise<void>;
  deleteMessages(ids: string[]): Promise<void>;
  clearMessages(): Promise<void>;
  getHistory(leafId?: string): Promise<UIMessage[]>;
  getLatestLeaf(): Promise<UIMessage | null>;
  getBranches(messageId: string): Promise<UIMessage[]>;
  getPathLength(): Promise<number>;
  addCompaction(
    summary: string,
    fromId: string,
    toId: string
  ): Promise<unknown>;
  getCompactions(): Promise<unknown[]>;
  search(
    query: string
  ): Promise<Array<{ id: string; role: string; content: string }>>;
  appendLinearChainForTest(count: number, prefix?: string): Promise<void>;
  corruptMessageForTest(id: string): Promise<void>;
  appendLargeChainForTest(
    count: number,
    charsPerMessage: number,
    prefix?: string
  ): Promise<void>;
  getHistoryTextLengthsForTest(): Promise<
    Array<{ id: string; textLength: number }>
  >;
  getRecentHistory(
    maxContentBytes: number,
    minRecentMessages?: number
  ): Promise<{
    messages: UIMessage[];
    truncated: boolean;
    totalContentBytes: number;
  }>;
  getHistoryRowStats(): Promise<Array<{
    id: string;
    role: string;
    bytes: number;
  }> | null>;
}

async function getAgent(name: string): Promise<SessionAgentStub> {
  return getAgentByName(
    env.TestSessionAgent,
    name
  ) as unknown as Promise<SessionAgentStub>;
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
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    });
    await agent.appendMessage({
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", text: "Hi" }]
    });

    const history = await agent.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe("m1");
    expect(history[1].id).toBe("m2");
  });

  it("getMessage by ID", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    });

    const msg = await agent.getMessage("m1");
    expect(msg?.id).toBe("m1");

    const missing = await agent.getMessage("nope");
    expect(missing).toBeNull();
  });

  it("tree structure — parentId links messages", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Root" }]
    });
    await agent.appendMessage({
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", text: "Reply" }]
    });

    const history = await agent.getHistory();
    expect(history.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(await agent.getPathLength()).toBe(2);
  });

  it("branching — multiple children of same parent", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Question" }]
    });
    // Two branches from m1
    await agent.appendMessage(
      {
        id: "m2a",
        role: "assistant",
        parts: [{ type: "text", text: "Answer A" }]
      },
      "m1"
    );
    await agent.appendMessage(
      {
        id: "m2b",
        role: "assistant",
        parts: [{ type: "text", text: "Answer B" }]
      },
      "m1"
    );

    const branches = await agent.getBranches("m1");
    expect(branches).toHaveLength(2);
    expect(branches.map((m) => m.id).sort()).toEqual(["m2a", "m2b"]);

    // Latest leaf is m2b (most recent)
    const leaf = await agent.getLatestLeaf();
    expect(leaf?.id).toBe("m2b");

    // getHistory from m2a branch
    const historyA = await agent.getHistory("m2a");
    expect(historyA.map((m) => m.id)).toEqual(["m1", "m2a"]);

    // getHistory from m2b branch
    const historyB = await agent.getHistory("m2b");
    expect(historyB.map((m) => m.id)).toEqual(["m1", "m2b"]);
  });

  it("updateMessage", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Original" }]
    });
    await agent.updateMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Updated" }]
    });

    const msg = await agent.getMessage("m1");
    expect(msg?.parts[0]).toEqual({ type: "text", text: "Updated" });
  });

  it("clearMessages", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Hi" }]
    });
    await agent.clearMessages();

    expect(await agent.getHistory()).toEqual([]);
    expect(await agent.getPathLength()).toBe(0);
  });

  it("idempotent append — same ID is no-op", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "First" }]
    });
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Duplicate" }]
    });

    const history = await agent.getHistory();
    expect(history).toHaveLength(1);
    // INSERT OR IGNORE — keeps the first
    expect(history[0].parts[0]).toEqual({ type: "text", text: "First" });
  });

  it("explicit null parentId creates a root message (no auto-parent)", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "first root" }]
    });
    await agent.appendMessage({
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", text: "reply" }]
    });

    // Explicit null → must become its own root, NOT a child of m2.
    await agent.appendMessage(
      {
        id: "m3",
        role: "user",
        parts: [{ type: "text", text: "new root" }]
      },
      null
    );

    const branches = await agent.getBranches("m2");
    expect(branches.map((b) => b.id)).not.toContain("m3");

    const historyFromM3 = await agent.getHistory("m3");
    expect(historyFromM3.map((m) => m.id)).toEqual(["m3"]);
  });

  it("omitted parentId auto-attaches to the latest leaf", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "first" }]
    });
    await agent.appendMessage({
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", text: "reply" }]
    });
    // No parentId → should be a child of m2.
    await agent.appendMessage({
      id: "m3",
      role: "user",
      parts: [{ type: "text", text: "follow-up" }]
    });

    const branches = await agent.getBranches("m2");
    expect(branches.map((b) => b.id)).toContain("m3");
  });

  it("compaction overlays — addCompaction replaces range in getHistory", async () => {
    const agent = await getAgent(name);
    for (let i = 0; i < 6; i++) {
      await agent.appendMessage({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `msg ${i}` }]
      });
    }

    // Compact middle messages (m1-m3)
    await agent.addCompaction("Summary of m1-m3", "m1", "m3");

    const history = await agent.getHistory();
    // m0 + compaction_summary + m4 + m5
    expect(history).toHaveLength(4);
    expect(history[0].id).toBe("m0");
    expect(history[1].id).toMatch(/^compaction_/);
    expect(history[1].parts[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Summary of m1-m3")
    });
    expect(history[2].id).toBe("m4");
    expect(history[3].id).toBe("m5");

    // Compactions are stored
    const compactions = await agent.getCompactions();
    expect(compactions).toHaveLength(1);
  });

  it("iterative compaction — new overlay supersedes old one at same fromId", async () => {
    const agent = await getAgent(name);

    // Add 10 messages
    for (let i = 0; i < 10; i++) {
      await agent.appendMessage({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `msg ${i}` }]
      });
    }

    // First compaction: summarize m1-m7, keep m0 (head) and m8-m9 (tail)
    await agent.addCompaction("Summary round 1", "m1", "m7");

    let history = await agent.getHistory();
    // m0 + summary1 + m8 + m9
    expect(history).toHaveLength(4);
    expect(history[0].id).toBe("m0");
    expect(history[1].id).toMatch(/^compaction_/);
    expect(history[2].id).toBe("m8");
    expect(history[3].id).toBe("m9");

    // Add more messages
    for (let i = 10; i < 15; i++) {
      await agent.appendMessage({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `msg ${i}` }]
      });
    }

    // Second compaction: supersede old one, cover m1-m12
    // (new summary incorporates round 1 summary + m8-m12)
    await agent.addCompaction("Summary round 2", "m1", "m12");

    history = await agent.getHistory();
    // m0 + summary2 + m13 + m14 (NOT summary1 — superseded)
    expect(history).toHaveLength(4);
    expect(history[0].id).toBe("m0");
    expect(history[1].id).toMatch(/^compaction_/);
    expect(history[1].parts[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Summary round 2")
    });
    expect(history[2].id).toBe("m13");
    expect(history[3].id).toBe("m14");

    // Both compactions stored, but only the latest applies
    const compactions = await agent.getCompactions();
    expect(compactions).toHaveLength(2);
  });

  it("FTS search", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "I love TypeScript" }]
    });
    await agent.appendMessage({
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", text: "Great choice" }]
    });
    await agent.appendMessage({
      id: "m3",
      role: "user",
      parts: [{ type: "text", text: "Python is also good" }]
    });

    const results = await agent.search("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("TypeScript");
  });

  it("persistence across agent lookups", async () => {
    const agent1 = await getAgent(name);
    await agent1.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }]
    });

    const agent2 = await getAgent(name);
    const history = await agent2.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe("m1");
  });
});

/**
 * getHistory hydrates content in bounded chunks (HISTORY_CONTENT_CHUNK_SIZE
 * = 50) instead of carrying message blobs through the recursive CTE and its
 * ORDER BY sorter, which exhausted SQLite's allocator on large transcripts
 * (#1710). These tests pin the behavior around the chunk boundary and the
 * read paths that were restructured.
 */
describe("AgentSessionProvider — chunked history hydration (#1710)", () => {
  let name: string;
  beforeEach(() => {
    name = `chunk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it("history of exactly one chunk (50) is returned complete and in order", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(50);

    const history = await agent.getHistory();
    expect(history.map((m) => m.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => `m${i}`)
    );
  });

  it("history one over the chunk boundary (51) is returned complete and in order", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(51);

    const history = await agent.getHistory();
    expect(history.map((m) => m.id)).toEqual(
      Array.from({ length: 51 }, (_, i) => `m${i}`)
    );
  });

  it("long history spanning several chunks preserves root→leaf order", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(120);

    const history = await agent.getHistory();
    expect(history.map((m) => m.id)).toEqual(
      Array.from({ length: 120 }, (_, i) => `m${i}`)
    );
    expect(await agent.getPathLength()).toBe(120);
  });

  it("getHistory(leafId) follows the selected branch across chunks", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(31); // m0..m30

    // Branch off m30 with 30 more messages: path length 61 spans two chunks.
    await agent.appendMessage(
      { id: "b0", role: "assistant", parts: [{ type: "text", text: "b 0" }] },
      "m30"
    );
    for (let i = 1; i < 30; i++) {
      await agent.appendMessage(
        {
          id: `b${i}`,
          role: i % 2 === 0 ? "assistant" : "user",
          parts: [{ type: "text", text: `b ${i}` }]
        },
        `b${i - 1}`
      );
    }
    // A competing branch off m30 so b29 is not the latest leaf.
    await agent.appendMessage(
      { id: "x0", role: "assistant", parts: [{ type: "text", text: "x" }] },
      "m30"
    );

    const history = await agent.getHistory("b29");
    expect(history.map((m) => m.id)).toEqual([
      ...Array.from({ length: 31 }, (_, i) => `m${i}`),
      ...Array.from({ length: 30 }, (_, i) => `b${i}`)
    ]);
  });

  it("compaction overlay applies across chunk boundaries", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(120);

    // Compacted range spans multiple content-fetch chunks.
    await agent.addCompaction("Summary of m10-m100", "m10", "m100");

    const history = await agent.getHistory();
    expect(history.map((m) => m.id)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `m${i}`),
      expect.stringMatching(/^compaction_/),
      ...Array.from({ length: 19 }, (_, i) => `m${101 + i}`)
    ]);
    expect(history[10].parts[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Summary of m10-m100")
    });
  });

  it("skips a corrupted row without dropping the rest of the history", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(10);
    await agent.corruptMessageForTest("m4");

    const history = await agent.getHistory();
    expect(history.map((m) => m.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i}`).filter((id) => id !== "m4")
    );
  });

  it("large message content round-trips intact", async () => {
    const agent = await getAgent(name);
    // Simulates an inline-media-sized payload (well below the 1.8MB row cap).
    const big = "x".repeat(200_000);
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: big }]
    });
    await agent.appendMessage({
      id: "m2",
      role: "assistant",
      parts: [{ type: "text", text: "ok" }]
    });

    const history = await agent.getHistory();
    expect(history).toHaveLength(2);
    expect((history[0].parts[0] as { text: string }).text).toHaveLength(
      200_000
    );
  });

  it("getLatestLeaf returns the full message after the id-only leaf lookup", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(3);

    const leaf = await agent.getLatestLeaf();
    expect(leaf?.id).toBe("m2");
    expect(leaf?.parts[0]).toEqual({ type: "text", text: "m message 2" });
  });
});

/**
 * Byte-budgeted history reads — hosts hydrate a bounded recent window
 * instead of the full transcript so wake-time memory scales with the
 * budget rather than total session history (#1710).
 */
describe("AgentSessionProvider — byte-budgeted recent history (#1710)", () => {
  let name: string;
  beforeEach(() => {
    name = `recent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it("empty session", async () => {
    const agent = await getAgent(name);
    const result = await agent.getRecentHistory(1024);
    expect(result).toEqual({
      messages: [],
      truncated: false,
      totalContentBytes: 0
    });
  });

  it("full history when it fits the budget", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(6);

    const result = await agent.getRecentHistory(10 * 1024 * 1024);
    expect(result.truncated).toBe(false);
    expect(result.messages.map((m) => m.id)).toEqual(
      Array.from({ length: 6 }, (_, i) => `m${i}`)
    );
    expect(result.totalContentBytes).toBeGreaterThan(0);
  });

  it("returns the most recent suffix when over budget, in order", async () => {
    const agent = await getAgent(name);
    // Each message ≈ 1KB of text plus envelope.
    for (let i = 0; i < 10; i++) {
      await agent.appendMessage({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: "x".repeat(1024) }]
      });
    }

    const result = await agent.getRecentHistory(3 * 1024);
    expect(result.truncated).toBe(true);
    const ids = result.messages.map((m) => m.id);
    // A suffix ending at the leaf, shorter than the full path.
    expect(ids.at(-1)).toBe("m9");
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.length).toBeLessThan(10);
    expect(ids).toEqual(
      Array.from({ length: ids.length }, (_, i) => `m${10 - ids.length + i}`)
    );
  });

  it("always includes the leaf even when it alone exceeds the budget", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "small",
      role: "user",
      parts: [{ type: "text", text: "hi" }]
    });
    await agent.appendMessage({
      id: "huge",
      role: "assistant",
      parts: [{ type: "text", text: "y".repeat(50_000) }]
    });

    const result = await agent.getRecentHistory(1024);
    expect(result.truncated).toBe(true);
    expect(result.messages.map((m) => m.id)).toEqual(["huge"]);
  });

  it("totalContentBytes matches the row stats sum", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(5);

    const stats = await agent.getHistoryRowStats();
    expect(stats).not.toBeNull();
    expect(stats!.map((s) => s.id)).toEqual(
      Array.from({ length: 5 }, (_, i) => `m${i}`)
    );
    for (const stat of stats!) {
      expect(stat.bytes).toBeGreaterThan(0);
    }

    const result = await agent.getRecentHistory(10 * 1024 * 1024);
    expect(result.totalContentBytes).toBe(
      stats!.reduce((sum, s) => sum + s.bytes, 0)
    );
  });

  it("row stats reflect content size differences", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "small",
      role: "user",
      parts: [{ type: "text", text: "hi" }]
    });
    await agent.appendMessage({
      id: "big",
      role: "assistant",
      parts: [{ type: "text", text: "z".repeat(10_000) }]
    });

    const stats = await agent.getHistoryRowStats();
    const small = stats!.find((s) => s.id === "small")!;
    const big = stats!.find((s) => s.id === "big")!;
    expect(big.bytes).toBeGreaterThan(small.bytes + 9_000);
  });

  it("compaction overlay applies when its range is inside the window", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(6);
    await agent.addCompaction("Window summary", "m1", "m3");

    const result = await agent.getRecentHistory(10 * 1024 * 1024);
    expect(result.messages.map((m) => m.id)).toEqual([
      "m0",
      expect.stringMatching(/^compaction_/),
      "m4",
      "m5"
    ]);
  });

  it("minRecentMessages floors the window even when those rows exceed the budget", async () => {
    const agent = await getAgent(name);
    // 10 × ~1KB messages; a 2KB budget alone fits at most 2.
    for (let i = 0; i < 10; i++) {
      await agent.appendMessage({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: "x".repeat(1024) }]
      });
    }

    const result = await agent.getRecentHistory(2 * 1024, 4);
    expect(result.truncated).toBe(true);
    expect(result.messages.map((m) => m.id)).toEqual(["m6", "m7", "m8", "m9"]);
  });

  it("minRecentMessages larger than the path returns the whole path untruncated", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(3);

    const result = await agent.getRecentHistory(1, 10);
    expect(result.truncated).toBe(false);
    expect(result.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
  });

  it("a corrupt row inside the window is skipped, not fatal", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(4);
    await agent.corruptMessageForTest("m3");

    // The window covers all rows; the corrupt LEAF row is dropped from the
    // parsed result (documented contract: parse failures can shrink the
    // window below the floor).
    const result = await agent.getRecentHistory(10 * 1024 * 1024);
    expect(result.truncated).toBe(false);
    expect(result.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    // The unparseable row still counts toward the stored size.
    expect(result.totalContentBytes).toBeGreaterThan(0);
  });

  it("row stats carry the stored role for content-free filtering", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(4);

    const stats = await agent.getHistoryRowStats();
    expect(stats!.map((s) => ({ id: s.id, role: s.role }))).toEqual([
      { id: "m0", role: "user" },
      { id: "m1", role: "assistant" },
      { id: "m2", role: "user" },
      { id: "m3", role: "assistant" }
    ]);
  });

  it("multi-megabyte paths round-trip across byte-bounded content chunks", async () => {
    const agent = await getAgent(name);
    // 4 × ~1.5MB rows ≈ 6MB total — crosses the 4MB per-chunk byte bound,
    // so content hydration must split into multiple statements and
    // reassemble in path order.
    await agent.appendLargeChainForTest(4, 1_500_000);

    const lengths = await agent.getHistoryTextLengthsForTest();
    expect(lengths.map((l) => l.id)).toEqual(["big0", "big1", "big2", "big3"]);
    for (const row of lengths) {
      expect(row.textLength).toBeGreaterThanOrEqual(1_500_000);
    }
  });
});
