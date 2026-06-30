import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type {
  ThinkScheduledTasksTestAgent,
  ThinkOnStartHydrationFailureAgent,
  ThinkRecoveryTestAgent
} from "./agents/think-session";

/**
 * Production-lifecycle eviction coverage using the real `evictDurableObject`
 * helper (vitest-pool-workers >= 0.16.20). Each test drives a DO until it has
 * built up BOTH in-memory and durable state, evicts it from memory (dropping the
 * in-memory instance while preserving SQLite + ctx.storage), then re-accesses
 * a freshly-routed stub and asserts the state was rebuilt correctly from
 * storage.
 *
 * These complement the recovery-fiber tests, which previously simulated
 * hibernation by hand-crafting SQL rows; here the runtime's own teardown drives
 * the rehydration path so the assertions fail if rebuild-from-storage breaks.
 *
 * Re-acquiring after eviction: a Think DO routes through partyserver, which sets
 * the DO's `name` (and thus rebuilds `this.session`) on the way in via
 * `getServerByName`. After eviction the instance is torn down, so the next
 * access must go through `getServerByName` again to re-run that init — exactly
 * as a real post-hibernation request does. `evictAndReacquire` does this.
 */

function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function recoveryAgent(name: string) {
  return getServerByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name
  );
}

async function scheduledAgent(name: string) {
  return getServerByName(
    env.ThinkScheduledTasksTestAgent as unknown as DurableObjectNamespace<ThinkScheduledTasksTestAgent>,
    name
  );
}

async function hydrationAgent(name: string) {
  return getServerByName(
    env.ThinkOnStartHydrationFailureAgent as unknown as DurableObjectNamespace<ThinkOnStartHydrationFailureAgent>,
    name
  );
}

/**
 * Schedule ids on the agent. `listSchedulesForTest` returns the deeply-generic
 * `Schedule<unknown>[]`, which the RPC stub-type machinery collapses to
 * `never[]`; read the ids through `unknown` so the assertion stays typed.
 */
async function scheduleIds(
  agent: Awaited<ReturnType<typeof scheduledAgent>>
): Promise<string[]> {
  const schedules = (await agent.listSchedulesForTest()) as unknown as Array<{
    id: string;
  }>;
  return schedules.map((s) => s.id);
}

/**
 * Evict the DO from memory, then return a freshly-routed stub for the same
 * name. Mirrors a real post-hibernation request: the runtime tore the instance
 * down, and the next routed request re-establishes the agent.
 */
async function evictAndReacquire<T>(
  stub: T,
  reacquire: () => Promise<T>
): Promise<T> {
  await evictDurableObject(stub as unknown as DurableObjectStub);
  return reacquire();
}

describe("Think DO eviction — _cachedMessages rehydration", () => {
  it("rebuilds the in-memory message cache from storage after eviction", async () => {
    const name = uniqueName("evict-cache");
    let agent = await recoveryAgent(name);

    // Build up a persisted transcript (durable) AND a populated in-memory cache.
    await agent.persistTestMessage({
      id: "u-evict-1",
      role: "user",
      parts: [{ type: "text", text: "first question" }]
    });
    await agent.persistTestMessage({
      id: "a-evict-1",
      role: "assistant",
      parts: [{ type: "text", text: "first answer" }]
    });

    // Confirm the live cache is populated pre-eviction.
    const before = (await agent.getStoredMessages()) as UIMessage[];
    expect(before.map((m) => m.id)).toEqual(["u-evict-1", "a-evict-1"]);

    // Simulate the production idle-eviction lifecycle: the in-memory instance
    // (and its `_cachedMessages`) is torn down; only durable storage survives.
    agent = await evictAndReacquire(agent, () => recoveryAgent(name));

    // The rebuilt instance's `_cachedMessages` (read via getStoredMessages ->
    // this.messages) must be rebuilt from cf_agent_chat_messages — same ids,
    // same order, no loss.
    const after = (await agent.getStoredMessages()) as UIMessage[];
    expect(after.map((m) => m.id)).toEqual(["u-evict-1", "a-evict-1"]);
    expect(after.map((m) => m.role)).toEqual(["user", "assistant"]);
    // The text content survived the round-trip through storage, not just the ids.
    const userText = (after[0].parts[0] as { type: string; text: string }).text;
    expect(userText).toBe("first question");

    // The wake did NOT re-execute any model turn — rehydration is a pure read.
    expect(await agent.getTurnCallCount()).toBe(0);
  });

  it("keeps the transcript consistent across a CHAIN of evictions", async () => {
    const name = uniqueName("evict-chain");
    let agent = await recoveryAgent(name);

    // Turn 1: a real programmatic turn (user + assistant persisted).
    const t1 = await agent.testRunTurnWait("first turn");
    expect(t1.status).toBe("completed");
    const afterT1 = (await agent.getStoredMessages()) as UIMessage[];
    expect(afterT1).toHaveLength(2);

    // Evict, then prove the transcript is intact and a fresh turn composes on
    // top of the rehydrated history.
    agent = await evictAndReacquire(agent, () => recoveryAgent(name));
    const afterEvict1 = (await agent.getStoredMessages()) as UIMessage[];
    expect(afterEvict1.map((m) => m.id)).toEqual(afterT1.map((m) => m.id));

    const t2 = await agent.testRunTurnWait("second turn");
    expect(t2.status).toBe("completed");
    const afterT2 = (await agent.getStoredMessages()) as UIMessage[];
    expect(afterT2).toHaveLength(4);

    // A SECOND eviction must not corrupt or duplicate the now-longer transcript.
    agent = await evictAndReacquire(agent, () => recoveryAgent(name));
    const afterEvict2 = (await agent.getStoredMessages()) as UIMessage[];
    expect(afterEvict2.map((m) => m.id)).toEqual(afterT2.map((m) => m.id));
    expect(afterEvict2.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
    // No leaked recovery fibers survived the eviction chain — clean turns leave
    // cf_agents_runs empty even after rehydration.
    expect(await agent.getActiveFibers()).toHaveLength(0);
  });
});

describe("Think DO eviction — scheduled task durability", () => {
  it("keeps declared schedule rows and their schedule ids after eviction", async () => {
    const name = uniqueName("evict-sched");
    let agent = await scheduledAgent(name);

    await agent.setDefaultTimezoneForTest("UTC");
    await agent.setScheduledTasksForTest({
      report: { schedule: "every day at 09:00", prompt: "Daily report" }
    });
    await agent.reconcileScheduledTasksForTest();

    const [before] = await agent.listDeclaredScheduledTaskRowsForTest();
    expect(before).toMatchObject({ task_id: "report" });
    expect(before.schedule_id).toBeTruthy();
    expect(await scheduleIds(agent)).toContain(before.schedule_id!);

    // Eviction drops the in-memory instance; the declared-task SQL rows
    // (cf_think_scheduled_tasks), the schedule rows (cf_agents_schedules), and
    // the durable `scheduledTasksConfig` must all survive in storage.
    agent = await evictAndReacquire(agent, () => scheduledAgent(name));

    const [after] = await agent.listDeclaredScheduledTaskRowsForTest();
    expect(after).toMatchObject({ task_id: "report" });
    // Same schedule id — eviction did NOT re-mint or drop the schedule.
    expect(after.schedule_id).toBe(before.schedule_id);
    expect(after.schedule_hash).toBe(before.schedule_hash);

    expect(await scheduleIds(agent)).toContain(after.schedule_id!);

    // A reconcile on the rehydrated instance is idempotent — same config means
    // the schedule id is reused, not replaced (proves the durable config was
    // read back, not lost-then-recreated).
    await agent.reconcileScheduledTasksForTest();
    const [afterReconcile] = await agent.listDeclaredScheduledTaskRowsForTest();
    expect(afterReconcile.schedule_id).toBe(before.schedule_id);
  });

  it("runs a declared task handler from durable state after eviction", async () => {
    const name = uniqueName("evict-sched-fire");
    let agent = await scheduledAgent(name);

    // A recording handler whose config (schedule + metadata) is persisted to
    // durable `scheduledTasksConfig` storage.
    await agent.setScheduledTasksForTest({
      workflow: {
        schedule: "every 1 minute",
        handler: "record",
        metadata: { workflowName: "daily-digest" }
      }
    });
    await agent.reconcileScheduledTasksForTest();
    const payload = await agent.getFirstDeclaredPayloadForTest();

    // Evict before the task ever runs: the schedule rows, the declared-task SQL
    // rows, AND the durable handler config must all rebuild from storage rather
    // than the (now-gone) in-memory state.
    agent = await evictAndReacquire(agent, () => scheduledAgent(name));

    // The rehydrated declared payload (recovered via getFirstDeclaredPayload from
    // storage) still resolves to the same occurrence...
    const reloaded = await agent.getFirstDeclaredPayloadForTest();
    expect(reloaded.taskId).toBe(payload.taskId);
    expect(reloaded.scheduledFor).toBe(payload.scheduledFor);

    // ...and running it dispatches the recording handler with the stored config
    // (metadata included), recording the occurrence durably. A broken rehydration
    // would lose the handler config and record nothing.
    await agent.runDeclaredPayloadForTest(reloaded);
    const events = await agent.listScheduledTaskHandlerEventsForTest();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: "workflow",
      scheduledFor: payload.scheduledFor,
      occurrenceKey: `workflow:${payload.scheduledFor}`,
      metadataJson: JSON.stringify({ workflowName: "daily-digest" })
    });
  });
});

describe("Think DO eviction — onStart hydration degradation", () => {
  it("re-runs the degraded onStart on each wake and stays functional after eviction", async () => {
    const name = uniqueName("evict-degraded");
    let agent = await hydrationAgent(name);

    // First wake: onStart's hydration read throws (simulated SQLITE_NOMEM) and is
    // recorded as a degradation rather than bricking the DO.
    const before = await agent.getOnStartDegradationsForTest();
    expect(before.map((d) => d.step)).toEqual(["transcript-hydration"]);

    // A turn after the degraded boot still persists durably.
    const turn = await agent.testChat("are you alive?");
    expect(turn.done).toBe(true);
    expect(turn.error).toBeUndefined();

    // Evict: a fresh wake must re-run onStart (which degrades AGAIN, since the
    // injected failure fails the first read of every new instance) and stay
    // serviceable rather than entering an unbounded init-reset loop.
    agent = await evictAndReacquire(agent, () => hydrationAgent(name));

    const after = await agent.getOnStartDegradationsForTest();
    expect(after.map((d) => d.step)).toEqual(["transcript-hydration"]);
    expect(after[0].error).toContain("SQLITE_NOMEM");

    // The durable transcript persisted before eviction is recoverable via the
    // safe-boundary resync on the rehydrated instance (the boot read degrades,
    // but a live read does not).
    const resynced = (await agent.resyncForTest()) as UIMessage[];
    expect(resynced.length).toBeGreaterThanOrEqual(2);
    expect(resynced.some((m) => m.role === "user")).toBe(true);
    expect(resynced.some((m) => m.role === "assistant")).toBe(true);
  });
});
