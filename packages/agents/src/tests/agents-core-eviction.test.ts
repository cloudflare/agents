/**
 * Forced Durable Object eviction coverage for the base Agent.
 *
 * `evictDurableObject()` tears down a running test actor while preserving its
 * durable storage. These tests prove that selected Agent state is reconstructed
 * from storage on the next access. They do not assert natural idle hibernation,
 * the absence of pending timers, or hibernation eligibility.
 */
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { FiberRecoveryContext } from "..";
import type { TestRunFiberAgent } from "./agents/run-fiber";
import type { TestScheduleAgent } from "./agents/schedule";

function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("Agent recovery after forced Durable Object eviction", () => {
  it("drops instance state while restoring persisted Agent state", async () => {
    const agent = await getAgentByName(
      env.TestStateAgent,
      uniqueName("evict-state")
    );
    const stored = {
      count: 314,
      items: ["before-eviction"],
      lastUpdated: "pre-evict"
    };

    await agent.updateState(stored);

    let calls = await agent.getStateUpdateCalls();
    const deadline = Date.now() + 1000;
    while (calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      calls = await agent.getStateUpdateCalls();
    }
    expect(calls.length).toBeGreaterThanOrEqual(1);

    await evictDurableObject(agent);

    // The hook log is instance-only, while the Agent state is SQL-backed.
    expect(await agent.getStateUpdateCalls()).toEqual([]);
    expect(await agent.getState()).toEqual(stored);
  });

  it("runs a persisted interval schedule on the reconstructed instance", async () => {
    const agent = await getAgentByName(
      env.TestScheduleAgent,
      uniqueName("evict-schedule")
    );
    const scheduleId = await agent.createIntervalSchedule(86_400);

    try {
      await agent.clearStoredAlarm();
      await agent.backdateSchedule(
        scheduleId,
        Math.floor(Date.now() / 1000) - 1
      );

      await evictDurableObject(agent);

      expect(
        await runInDurableObject(
          agent,
          (instance: TestScheduleAgent) => instance.intervalCallbackCount
        )
      ).toBe(0);
      expect((await agent.getStoredScheduleById(scheduleId))?.id).toBe(
        scheduleId
      );

      await agent.setStoredAlarm(Date.now() + 1000);
      await runDurableObjectAlarm(agent);

      expect(
        await runInDurableObject(
          agent,
          (instance: TestScheduleAgent) => instance.intervalCallbackCount
        )
      ).toBe(1);
      expect(await agent.getScheduleCount()).toBe(1);
    } finally {
      await agent.cancelScheduleById(scheduleId);
      await agent.clearStoredAlarm();
    }
  });

  it("recovers an interrupted unmanaged fiber from SQL", async () => {
    const stub = await getAgentByName(
      env.TestRunFiberAgent,
      uniqueName("evict-fiber")
    );
    const agent = stub as unknown as TestRunFiberAgent;

    await agent.insertInterruptedFiber("evicted-fiber", "research", {
      step: 7
    });
    await agent.runSimple("warm");
    expect(await agent.getExecutionLog()).toContain("executed:warm");

    await evictDurableObject(stub);

    expect(await agent.getExecutionLog()).not.toContain("executed:warm");
    expect(await agent.getRunningFiberCount()).toBe(1);

    await agent.triggerRecoveryCheck();

    const recovered =
      (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
    expect(recovered).toEqual([
      expect.objectContaining({
        id: "evicted-fiber",
        name: "research",
        snapshot: { step: 7 },
        recoveryReason: "interrupted"
      })
    ]);
    expect(await agent.getRunningFiberCount()).toBe(0);
  });

  it("applies managed-fiber recovery on a fresh instance", async () => {
    const stub = await getAgentByName(
      env.TestRunFiberAgent,
      uniqueName("evict-managed-fiber")
    );
    const agent = stub as unknown as TestRunFiberAgent;

    await agent.insertInterruptedManagedFiber(
      "evicted-managed",
      "managed-recovery-complete",
      { progress: 42 }
    );

    await evictDurableObject(stub);

    expect(await agent.getRecoveredFibers()).toEqual([]);
    await agent.simulateAlarmCycle();

    const recovered =
      (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
    expect(recovered).toEqual([
      expect.objectContaining({
        id: "evicted-managed",
        snapshot: { progress: 42 }
      })
    ]);
    expect((await agent.inspectManagedFiber("evicted-managed"))?.status).toBe(
      "completed"
    );
  });
});
