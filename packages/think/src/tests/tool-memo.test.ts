import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

async function freshAgent(name: string) {
  return getAgentByName(env.ThinkToolMemoTestAgent, name);
}

describe("Think tool-set memoisation", () => {
  it("reuses built tools across turns and continuations, refreshes skills once per turn", async () => {
    const agent = await freshAgent(`tool-memo-${crypto.randomUUID()}`);
    await agent.setSkillsRefreshForTest("every-turn");

    const turn1 = await agent.runTurnForTest("first");
    expect(turn1.status).toBe("completed");
    const afterTurn1 = await agent.snapshotForTest();
    // onStart loads the catalog once; the first turn refreshes it once.
    expect(afterTurn1.skillListCalls).toBe(2);
    expect(afterTurn1.skillRefreshCalls).toBe(1);

    const continuation = await agent.runContinuationForTest();
    expect(continuation.status).toBe("completed");
    const afterContinuation = await agent.snapshotForTest();
    // A continuation keeps the catalog the turn started with.
    expect(afterContinuation.skillListCalls).toBe(2);
    expect(afterContinuation.skillRefreshCalls).toBe(1);

    const turn2 = await agent.runTurnForTest("second");
    expect(turn2.status).toBe("completed");
    const afterTurn2 = await agent.snapshotForTest();
    expect(afterTurn2.skillListCalls).toBe(3);
    expect(afterTurn2.skillRefreshCalls).toBe(2);

    // User hooks are still consulted on every inference attempt.
    expect(afterTurn2.getToolsCalls).toBe(3);
    expect(afterTurn2.getActionsCalls).toBe(3);

    // The built tool objects are the same across all three attempts.
    expect(afterTurn2.attempts.map((a) => a.continuation)).toEqual([
      false,
      true,
      false
    ]);
    for (const attempt of afterTurn2.attempts) {
      expect(attempt).toMatchObject({
        sameWorkspaceTool: true,
        sameActionTool: true,
        sameSkillTool: true,
        sameContextTool: true
      });
    }
  });

  it("defaults to one refresh per minute", async () => {
    const agent = await freshAgent(`tool-memo-default-${crypto.randomUUID()}`);
    await agent.runTurnForTest("first");
    await agent.runTurnForTest("second");
    const snapshot = await agent.snapshotForTest();
    expect(snapshot.skillRefreshCalls).toBe(1);
    expect(snapshot.skillListCalls).toBe(2);
  });

  it("skillsRefresh: 'on-start' never re-lists sources after onStart", async () => {
    const agent = await freshAgent(`tool-memo-on-start-${crypto.randomUUID()}`);
    await agent.setSkillsRefreshForTest("on-start");

    await agent.runTurnForTest("first");
    await agent.runTurnForTest("second");
    const snapshot = await agent.snapshotForTest();
    expect(snapshot.skillListCalls).toBe(1);
    expect(snapshot.skillRefreshCalls).toBe(0);
  });

  it("skillsRefresh: { intervalMs } refreshes at most once per interval", async () => {
    const agent = await freshAgent(`tool-memo-interval-${crypto.randomUUID()}`);
    await agent.setSkillsRefreshForTest({ intervalMs: 60_000 });

    await agent.runTurnForTest("first");
    await agent.runTurnForTest("second");
    await agent.runTurnForTest("third");
    const snapshot = await agent.snapshotForTest();
    // One refresh on the first turn (the interval has never elapsed before),
    // none within the following minute.
    expect(snapshot.skillRefreshCalls).toBe(1);
    expect(snapshot.skillListCalls).toBe(2);
  });
});

describe("Think skill catalog changes between turns", () => {
  it("re-renders the next turn's system prompt once and leaves persisted rows untouched", async () => {
    const agent = await getAgentByName(
      env.ThinkSkillChangeTestAgent,
      `skill-change-${crypto.randomUUID()}`
    );

    // Turn 1 activates the skill so its v1 body lands in the transcript.
    expect(
      (await agent.runTurnForTest("first", { activateSkill: true })).status
    ).toBe("completed");
    const rowsAfterTurn1 = await agent.persistedRowsForTest();
    expect(rowsAfterTurn1.length).toBeGreaterThanOrEqual(2);
    expect(
      rowsAfterTurn1.some((row) => row.json.includes("Hitch instructions v1."))
    ).toBe(true);

    await agent.bumpSkillForTest();
    expect((await agent.runTurnForTest("second")).status).toBe("completed");
    expect((await agent.runTurnForTest("third")).status).toBe("completed");

    // Rows persisted before the change are byte-identical afterwards.
    const rowsAfterTurn3 = await agent.persistedRowsForTest();
    const byId = new Map(rowsAfterTurn3.map((row) => [row.id, row.json]));
    for (const row of rowsAfterTurn1) {
      expect(byId.get(row.id)).toBe(row.json);
    }
    expect(rowsAfterTurn3.some((row) => row.json.includes("Knots v2."))).toBe(
      false
    );

    // Turn 1 (two model calls) saw v1; turns 2 and 3 saw v2, with an identical
    // prompt so the cache prefix changed exactly once.
    const prompts = await agent.systemPromptsForTest();
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toContain("Knots v1.");
    expect(prompts[0]).not.toContain("Knots v2.");
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[2]).toContain("Knots v2.");
    expect(prompts[2]).not.toContain("Knots v1.");
    expect(prompts[3]).toBe(prompts[2]);
  });
});
