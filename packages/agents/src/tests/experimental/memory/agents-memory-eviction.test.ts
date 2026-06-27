/**
 * Durable Object eviction tests for the `agents-memory` (experimental Session)
 * module.
 *
 * These exercise the production hibernation/eviction lifecycle with the real
 * `evictDurableObject` / `evictAllDurableObjects` helpers from
 * "cloudflare:test" (vitest-pool-workers >= 0.16.20). Eviction tears down the
 * DO instance — dropping all in-memory state, including the
 * `AgentSessionProvider.activeLeafId` cache and the `Session` skill-restore
 * tracking — while preserving durable SQLite storage. On the next access the
 * DO is rebuilt from storage.
 *
 * Each test drives a `TestSessionAgent` to build up real in-memory + stored
 * state, evicts it, then re-accesses and asserts the state rehydrated
 * correctly from SQLite. The assertions fail if rehydration is broken: they
 * are not vacuous "still works" smoke checks.
 *
 * `TestSessionAgent` is the same fixture used by
 * `experimental/memory/session/provider.test.ts`; it exposes `antiJoinCount`
 * instrumentation that lets us prove the in-memory active-leaf cache was lost
 * and rebuilt (rather than silently surviving, which would mean eviction
 * isn't really tearing the instance down).
 */
import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { evictAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getAgentByName } from "../../..";

/**
 * Typed stub for TestSessionAgent — mirrors the SessionAgentStub used in
 * provider.test.ts so these eviction tests share the same conventions.
 */
interface SessionAgentStub {
  appendMessage(message: UIMessage, parentId?: string | null): Promise<void>;
  getMessage(id: string): Promise<UIMessage | null>;
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
  corruptMessageForTest(id: string): Promise<void>;
  getAntiJoinCountForTest(): Promise<number>;
  resetAntiJoinCountForTest(): Promise<void>;
}

/**
 * The stub returned by `getAgentByName` is the live DurableObjectStub — the
 * same value `schedule.test.ts` hands to `runInDurableObject` /
 * `runDurableObjectAlarm`, so it's also the value `evictDurableObject` takes.
 */
async function getAgent(name: string): Promise<SessionAgentStub> {
  return getAgentByName(
    env.TestSessionAgent,
    name
  ) as unknown as Promise<SessionAgentStub>;
}

/**
 * `evictDurableObject` takes a `DurableObjectStub`. Our `SessionAgentStub` is
 * the same live stub typed for RPC ergonomics; cast once here so call sites
 * stay readable.
 */
function evict(
  agent: SessionAgentStub,
  options?: { webSockets: "close" | "hibernate" }
): Promise<void> {
  return evictDurableObject(agent as unknown as DurableObjectStub, options);
}

describe("agents-memory Session — Durable Object eviction", () => {
  let name: string;
  beforeEach(() => {
    name = `evict-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it("rebuilds the active-leaf cache from storage after eviction (exactly one anti-join)", async () => {
    const agent = await getAgent(name);
    // Build a long chain so a from-scratch leaf scan is meaningfully expensive
    // and the cache is genuinely warm before we evict.
    await agent.appendLinearChainForTest(20); // m0..m19
    expect((await agent.getLatestLeaf())?.id).toBe("m19");

    // Warm cache: repeated reads cost zero anti-joins while the instance lives.
    await agent.resetAntiJoinCountForTest();
    expect((await agent.getLatestLeaf())?.id).toBe("m19");
    expect(await agent.getAntiJoinCountForTest()).toBe(0);

    // Evict: the DO instance is torn down. The provider's in-memory
    // `activeLeafId` cache (and the counter) are gone; only SQLite remains.
    await evict(agent);

    // First leaf lookup on the rebuilt instance must recompute the tip from
    // storage — exactly one anti-join. If the cache had somehow survived
    // eviction this would be 0 and the test would (correctly) fail, proving
    // eviction really resets in-memory state.
    expect((await agent.getLatestLeaf())?.id).toBe("m19");
    expect(await agent.getAntiJoinCountForTest()).toBe(1);

    // ...and it's re-warmed: subsequent reads on the rebuilt instance are free.
    await agent.resetAntiJoinCountForTest();
    expect((await agent.getLatestLeaf())?.id).toBe("m19");
    await agent.appendMessage({
      id: "after",
      role: "user",
      parts: [{ type: "text", text: "after eviction" }]
    });
    expect((await agent.getLatestLeaf())?.id).toBe("after");
    expect(await agent.getAntiJoinCountForTest()).toBe(0);
  });

  it("auto-parenting after eviction attaches to the rehydrated tip, not a new root", async () => {
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

    await evict(agent);

    // No parentId: the rebuilt provider must recover the tip (m2) from storage
    // and attach to it. A broken rehydration would orphan m3 as a new root.
    await agent.appendMessage({
      id: "m3",
      role: "user",
      parts: [{ type: "text", text: "follow-up after wake" }]
    });

    expect((await agent.getBranches("m2")).map((b) => b.id)).toContain("m3");
    expect((await agent.getHistory()).map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3"
    ]);
    expect(await agent.getPathLength()).toBe(3);
  });

  it("conversation tree (branches + parent links) survives eviction", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "root",
      role: "user",
      parts: [{ type: "text", text: "Question" }]
    });
    await agent.appendMessage(
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "text", text: "Answer A" }]
      },
      "root"
    );
    await agent.appendMessage(
      {
        id: "b",
        role: "assistant",
        parts: [{ type: "text", text: "Answer B" }]
      },
      "root"
    );

    await evict(agent);

    // The whole tree must come back from SQLite with structure intact.
    const branches = await agent.getBranches("root");
    expect(branches.map((m) => m.id).sort()).toEqual(["a", "b"]);

    expect((await agent.getHistory("a")).map((m) => m.id)).toEqual([
      "root",
      "a"
    ]);
    expect((await agent.getHistory("b")).map((m) => m.id)).toEqual([
      "root",
      "b"
    ]);

    const restored = await agent.getMessage("a");
    expect(restored?.parts[0]).toEqual({ type: "text", text: "Answer A" });
    // Latest leaf is the most-recent childless node (b).
    expect((await agent.getLatestLeaf())?.id).toBe("b");
  });

  it("compaction overlays survive eviction and still rewrite history", async () => {
    const agent = await getAgent(name);
    for (let i = 0; i < 6; i++) {
      await agent.appendMessage({
        id: `m${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `msg ${i}` }]
      });
    }
    await agent.addCompaction("Summary of m1-m3", "m1", "m3");

    await evict(agent);

    // The compaction lives in assistant_compactions (SQLite); after wake the
    // overlay must still collapse m1..m3 into the stored summary.
    const history = await agent.getHistory();
    expect(history.map((m) => m.id)).toEqual([
      "m0",
      expect.stringMatching(/^compaction_/),
      "m4",
      "m5"
    ]);
    expect(history[1].parts[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Summary of m1-m3")
    });
    expect(await agent.getCompactions()).toHaveLength(1);
  });

  it("FTS5 search index survives eviction", async () => {
    const agent = await getAgent(name);
    await agent.appendMessage({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "I love TypeScript" }]
    });
    await agent.appendMessage({
      id: "m2",
      role: "user",
      parts: [{ type: "text", text: "Python is also good" }]
    });

    await evict(agent);

    // assistant_fts is a persisted virtual table; search must still hit after
    // the index is reloaded from storage.
    const results = await agent.search("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("TypeScript");
    // Negative control: a term only in the other message still resolves to it,
    // not to the TypeScript row.
    const python = await agent.search("Python");
    expect(python.map((r) => r.id)).toContain("m2");
  });

  it("multi-megabyte chained messages round-trip through chunked hydration after eviction", async () => {
    const agent = await getAgent(name);
    // 4 × ~1.5MB rows ≈ 6MB — crosses the 4MB per-chunk byte bound, so content
    // hydration must split across statements and reassemble in path order.
    await agent.appendLargeChainForTest(4, 1_500_000);

    await evict(agent);

    // After a real wake the byte-bounded chunked read path must still
    // reassemble every large row in order, intact.
    const lengths = await agent.getHistoryTextLengthsForTest();
    expect(lengths.map((l) => l.id)).toEqual(["big0", "big1", "big2", "big3"]);
    for (const row of lengths) {
      expect(row.textLength).toBeGreaterThanOrEqual(1_500_000);
    }

    // The byte-budgeted recent window must still honour its budget post-wake:
    // a tiny budget yields only the leaf, but the leaf row content survives.
    const recent = await agent.getRecentHistory(1024);
    expect(recent.truncated).toBe(true);
    expect(recent.messages.map((m) => m.id)).toEqual(["big3"]);
  });

  it("corrupted-row recovery is stable across eviction", async () => {
    const agent = await getAgent(name);
    await agent.appendLinearChainForTest(10); // m0..m9
    await agent.corruptMessageForTest("m4");

    // Before eviction the corrupt row is skipped, rest intact.
    const before = await agent.getHistory();
    expect(before.map((m) => m.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i}`).filter((id) => id !== "m4")
    );

    await evict(agent);

    // The corruption is in stored content; after the instance is rebuilt the
    // read path must still tolerate it identically — not throw, not drop the
    // rest of the chain.
    const after = await agent.getHistory();
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
  });

  it("evictAllDurableObjects preserves and isolates per-DO session history", async () => {
    const nameA = `${name}-a`;
    const nameB = `${name}-b`;
    const agentA = await getAgent(nameA);
    const agentB = await getAgent(nameB);

    await agentA.appendMessage({
      id: "a1",
      role: "user",
      parts: [{ type: "text", text: "hello from A" }]
    });
    await agentA.appendMessage({
      id: "a2",
      role: "assistant",
      parts: [{ type: "text", text: "reply A" }]
    });
    await agentB.appendMessage({
      id: "b1",
      role: "user",
      parts: [{ type: "text", text: "hello from B" }]
    });

    // Evict every running DO at once (production-style memory reclamation).
    await evictAllDurableObjects();

    // Each DO rehydrates its own SQLite-backed history independently — no
    // bleed between the two evicted instances.
    const historyA = await agentA.getHistory();
    expect(historyA.map((m) => m.id)).toEqual(["a1", "a2"]);
    const historyB = await agentB.getHistory();
    expect(historyB.map((m) => m.id)).toEqual(["b1"]);

    // Continuing each conversation after the mass eviction still auto-parents
    // onto the rehydrated tip.
    await agentA.appendMessage({
      id: "a3",
      role: "user",
      parts: [{ type: "text", text: "more A" }]
    });
    expect((await agentA.getHistory()).map((m) => m.id)).toEqual([
      "a1",
      "a2",
      "a3"
    ]);
    expect((await agentB.getHistory()).map((m) => m.id)).toEqual(["b1"]);
  });

  it("history accumulated across two evictions stays consistent", async () => {
    const agent = await getAgent(name);

    await agent.appendLinearChainForTest(5); // m0..m4
    await evict(agent);

    // Append more after the first wake (ids n*), then evict again.
    await agent.appendMessage({
      id: "n0",
      role: "user",
      parts: [{ type: "text", text: "round two" }]
    });
    await agent.appendMessage({
      id: "n1",
      role: "assistant",
      parts: [{ type: "text", text: "round two reply" }]
    });
    await evict(agent);

    // Everything from both eras must be present and correctly ordered after a
    // second wake from storage.
    const history = await agent.getHistory();
    expect(history.map((m) => m.id)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
      "n0",
      "n1"
    ]);
    expect(await agent.getPathLength()).toBe(7);
    expect((await agent.getLatestLeaf())?.id).toBe("n1");
  });
});
