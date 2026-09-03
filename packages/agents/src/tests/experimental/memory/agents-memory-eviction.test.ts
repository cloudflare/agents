/**
 * Forced Durable Object eviction coverage for Session storage.
 *
 * These tests tear down running test actors and verify that a new Session
 * instance reconstructs its active-leaf cache from SQLite. They do not assert
 * natural idle hibernation or hibernation eligibility.
 */
import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { evictAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../../..";

interface SessionAgentStub {
  appendMessage(message: UIMessage, parentId?: string | null): Promise<void>;
  getHistory(): Promise<UIMessage[]>;
  getLatestLeaf(): Promise<UIMessage | null>;
  getBranches(messageId: string): Promise<UIMessage[]>;
  appendLinearChainForTest(count: number, prefix?: string): Promise<void>;
  getAntiJoinCountForTest(): Promise<number>;
  resetAntiJoinCountForTest(): Promise<void>;
}

async function getAgent(name: string): Promise<SessionAgentStub> {
  return getAgentByName(
    env.TestSessionAgent,
    name
  ) as unknown as Promise<SessionAgentStub>;
}

async function evict(agent: SessionAgentStub): Promise<void> {
  await evictDurableObject(agent as unknown as DurableObjectStub);
}

function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("Session recovery after forced Durable Object eviction", () => {
  it("rebuilds and rewarms the active-leaf cache from SQLite", async () => {
    const agent = await getAgent(uniqueName("evict-session"));
    await agent.appendLinearChainForTest(20);
    expect((await agent.getLatestLeaf())?.id).toBe("m19");

    await agent.resetAntiJoinCountForTest();
    expect((await agent.getLatestLeaf())?.id).toBe("m19");
    expect(await agent.getAntiJoinCountForTest()).toBe(0);

    await evict(agent);

    // A reconstructed provider has no activeLeafId cache. Its first lookup must
    // discover the tip once; subsequent auto-parenting uses the warmed cache.
    expect((await agent.getLatestLeaf())?.id).toBe("m19");
    expect(await agent.getAntiJoinCountForTest()).toBe(1);

    await agent.resetAntiJoinCountForTest();
    await agent.appendMessage({
      id: "after",
      role: "user",
      parts: [{ type: "text", text: "after eviction" }]
    });

    expect(
      (await agent.getBranches("m19")).map((message) => message.id)
    ).toEqual(["after"]);
    expect((await agent.getHistory()).map((message) => message.id)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => `m${index}`),
      "after"
    ]);
    expect(await agent.getAntiJoinCountForTest()).toBe(0);
  });

  it("keeps named Session histories isolated after a global forced eviction", async () => {
    const agentA = await getAgent(uniqueName("evict-session-a"));
    const agentB = await getAgent(uniqueName("evict-session-b"));

    await agentA.appendMessage({
      id: "a1",
      role: "user",
      parts: [{ type: "text", text: "A" }]
    });
    await agentB.appendMessage({
      id: "b1",
      role: "user",
      parts: [{ type: "text", text: "B" }]
    });

    await evictAllDurableObjects();

    expect((await agentA.getHistory()).map((message) => message.id)).toEqual([
      "a1"
    ]);
    expect((await agentB.getHistory()).map((message) => message.id)).toEqual([
      "b1"
    ]);
  });
});
