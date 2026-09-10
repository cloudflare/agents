import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

async function freshAgent(name: string) {
  return getAgentByName(env.ThinkToolMemoTestAgent, name);
}

describe("Think tool-set memoisation", () => {
  it("reuses built tools across turns and continuations, refreshes skills once per turn", async () => {
    const agent = await freshAgent(`tool-memo-${crypto.randomUUID()}`);

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
