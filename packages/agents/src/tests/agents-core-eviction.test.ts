/**
 * Durable Object eviction tests for agents-core.
 *
 * These prove that Agent-backed state survives a *real* production-like
 * eviction: `evictDurableObject(stub)` tears down the in-memory instance
 * (dropping caches, in-flight maps, ref counters, recovery sets) while
 * leaving durable storage intact. The next access rehydrates from SQL.
 *
 * Unlike the "get a fresh stub (simulates restart)" idiom used elsewhere in
 * this package, evictDurableObject exercises the same code path the platform
 * runs when an idle DO is evicted from memory — so it also verifies that the
 * in-memory state is genuinely dropped, not merely re-read from a stub that
 * happened to point at the same warm instance.
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
import type { TestKeepAliveAgent } from "./agents/keep-alive";
import type { TestRunFiberAgent } from "./agents/run-fiber";
import type { TestScheduleAgent } from "./agents/schedule";

describe("DO eviction (evictDurableObject)", () => {
  describe("state cache rehydration", () => {
    it("rebuilds in-memory state from SQL after eviction", async () => {
      const agent = await getAgentByName(
        env.TestStateAgent,
        `evict-state-${crypto.randomUUID()}`
      );

      const stored = {
        count: 314,
        items: ["before-eviction"],
        lastUpdated: "pre-evict"
      };
      await agent.updateState(stored);
      expect(await agent.getState()).toEqual(stored);

      // Real eviction: the in-memory `_state` cache is dropped here.
      await evictDurableObject(agent);

      // Next access must rehydrate `_state` from the cf_agents_state table.
      // If rehydration were broken this would surface as initialState / undefined.
      const rehydrated = await agent.getState();
      expect(rehydrated).toEqual(stored);
    });

    it("drops in-memory onStateChanged call log on eviction (cache is genuinely fresh)", async () => {
      const agent = await getAgentByName(
        env.TestStateAgent,
        `evict-state-log-${crypto.randomUUID()}`
      );

      await agent.updateState({
        count: 1,
        items: ["a"],
        lastUpdated: "first"
      });

      // The onStateChanged hook pushes into an in-memory array. Poll until the
      // waitUntil-scheduled hook has recorded the call.
      let calls = await agent.getStateUpdateCalls();
      const start = Date.now();
      while (calls.length === 0 && Date.now() - start < 1000) {
        await new Promise((r) => setTimeout(r, 10));
        calls = await agent.getStateUpdateCalls();
      }
      expect(calls.length).toBeGreaterThanOrEqual(1);

      // Evict: a real eviction tears down the instance, so the in-memory log
      // (which is NOT persisted) must be empty when the instance is rebuilt.
      await evictDurableObject(agent);

      const afterEviction = await agent.getStateUpdateCalls();
      expect(afterEviction.length).toBe(0);

      // ...but the persisted state itself is untouched.
      expect(await agent.getState()).toEqual({
        count: 1,
        items: ["a"],
        lastUpdated: "first"
      });
    });

    it("recovers state set across multiple eviction round-trips", async () => {
      const agent = await getAgentByName(
        env.TestStateAgent,
        `evict-state-roundtrips-${crypto.randomUUID()}`
      );

      for (let i = 0; i < 3; i++) {
        const state = {
          count: i,
          items: [`round-${i}`],
          lastUpdated: `r${i}`
        };
        await agent.updateState(state);
        await evictDurableObject(agent);
        expect(await agent.getState()).toEqual(state);
      }
    });
  });

  describe("scheduled callbacks survive eviction", () => {
    it("fires a persisted interval schedule after the DO is evicted", async () => {
      const agent = await getAgentByName(
        env.TestScheduleAgent,
        `evict-schedule-${crypto.randomUUID()}`
      );

      // Reset the in-memory execution counter so the assertion is unambiguous.
      await runInDurableObject(agent, (instance: TestScheduleAgent) => {
        instance.intervalCallbackCount = 0;
      });

      const scheduleId = await agent.createIntervalSchedule(1);

      // Backdate the schedule row so the alarm scan considers it due.
      await runInDurableObject(agent, (instance: TestScheduleAgent) => {
        const past = Math.floor(Date.now() / 1000) - 1;
        instance.sql`UPDATE cf_agents_schedules SET time = ${past} WHERE id = ${scheduleId}`;
      });

      // Evict the DO. The interval row lives in cf_agents_schedules (durable);
      // the in-memory intervalCallbackCount is dropped.
      await evictDurableObject(agent);

      // Confirm the in-memory counter really was reset by the eviction.
      const countAfterEvict = await runInDurableObject(
        agent,
        (instance: TestScheduleAgent) => instance.intervalCallbackCount
      );
      expect(countAfterEvict).toBe(0);

      // Re-arm the alarm (the eviction-rebuilt instance recomputed schedules)
      // and fire it deterministically.
      await agent.setStoredAlarm(Date.now() + 1000);
      await runDurableObjectAlarm(agent);

      // The persisted schedule must have executed against the freshly
      // rehydrated instance.
      const count = await runInDurableObject(
        agent,
        (instance: TestScheduleAgent) => instance.intervalCallbackCount
      );
      expect(count).toBeGreaterThan(0);

      // The interval schedule should still be present (it re-arms itself).
      const remaining = await agent.getScheduleCount();
      expect(remaining).toBeGreaterThanOrEqual(1);

      await agent.cancelScheduleById(scheduleId);
    });

    it("keeps a one-shot delayed schedule durable across eviction", async () => {
      const agent = await getAgentByName(
        env.TestScheduleAgent,
        `evict-oneshot-${crypto.randomUUID()}`
      );

      await runInDurableObject(agent, (instance: TestScheduleAgent) => {
        instance.intervalCallbackCount = 0;
      });

      // Far-future delay so nothing auto-fires before we drive the alarm.
      const scheduleId = await agent.createSchedule(86_400);
      expect(await agent.getScheduleCount()).toBe(1);

      await evictDurableObject(agent);

      // The row survives eviction and is still queryable from the rebuilt
      // instance.
      expect(await agent.getScheduleCount()).toBe(1);
      const row = await agent.getStoredScheduleById(scheduleId);
      expect(row?.id).toBe(scheduleId);

      await agent.cancelScheduleById(scheduleId);
    });
  });

  describe("keepAlive ref counting across eviction", () => {
    it("drops in-memory keepAlive refs on eviction (in-memory work is also lost)", async () => {
      const agent = await getAgentByName(
        env.TestKeepAliveAgent,
        `evict-keepalive-${crypto.randomUUID()}`
      );

      await agent.startKeepAlive();
      await agent.startKeepAlive();
      expect(await getKeepAliveRefs(agent)).toBe(2);

      // A held keepAlive arms a heartbeat alarm.
      expect(await agent.getCurrentAlarm()).not.toBeNull();

      // Evict: the ref counter protects in-memory work that no longer exists
      // after eviction, so it MUST reset rather than carry stale leases over.
      await evictDurableObject(agent);

      expect(await getKeepAliveRefs(agent)).toBe(0);

      // Acquiring again on the rebuilt instance must produce an independent
      // count (1, not 3) and re-arm the heartbeat cleanly.
      await agent.startKeepAlive();
      expect(await getKeepAliveRefs(agent)).toBe(1);
      expect(await agent.getCurrentAlarm()).not.toBeNull();
    });

    it("does not leak a stale heartbeat: eviction with no live work leaves no refs", async () => {
      const agent = await getAgentByName(
        env.TestKeepAliveAgent,
        `evict-keepalive-clean-${crypto.randomUUID()}`
      );

      await agent.startKeepAlive();
      expect(await getKeepAliveRefs(agent)).toBe(1);

      await evictDurableObject(agent);

      // No leases carried over, and no schedule rows were ever created by
      // keepAlive (it uses the heartbeat alarm, not cf_agents_schedules).
      expect(await getKeepAliveRefs(agent)).toBe(0);
      expect(await agent.getScheduleCount()).toBe(0);
    });
  });

  describe("fiber recovery after eviction", () => {
    it("recovers an interrupted unmanaged fiber from SQL after eviction", async () => {
      const stub = await getAgentByName(
        env.TestRunFiberAgent,
        `evict-fiber-unmanaged-${crypto.randomUUID()}`
      );
      const agent = stub as unknown as TestRunFiberAgent;

      // Pre-eviction: an interrupted fiber row exists in cf_agents_runs and the
      // in-memory recovery log is non-empty from an earlier scan.
      await agent.insertInterruptedFiber("evicted-fiber-1", "research", {
        step: 7
      });

      // Prime the in-memory log with an unrelated entry so we can prove it is
      // dropped by the eviction (not merely overwritten).
      await agent.runSimple("warm");
      const logBefore = await agent.getExecutionLog();
      expect(logBefore).toContain("executed:warm");

      // Real eviction tears down recoveredFibers, executionLog and the
      // _runFiberActiveFibers set.
      await evictDurableObject(stub);

      // The in-memory execution log is gone; the fiber row is not.
      const logAfter = await agent.getExecutionLog();
      expect(logAfter).not.toContain("executed:warm");
      expect(await agent.getRunningFiberCount()).toBe(1);

      // Drive the recovery scan on the rebuilt instance. onFiberRecovered must
      // fire from the persisted cf_agents_runs snapshot.
      await agent.triggerRecoveryCheck();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered.length).toBe(1);
      expect(recovered[0].id).toBe("evicted-fiber-1");
      expect(recovered[0].name).toBe("research");
      expect(recovered[0].snapshot).toEqual({ step: 7 });
      expect(recovered[0].recoveryReason).toBe("interrupted");

      // Recovery deletes the row.
      expect(await agent.getRunningFiberCount()).toBe(0);
    });

    it("applies a managed-fiber recovery result after eviction via the alarm", async () => {
      const stub = await getAgentByName(
        env.TestRunFiberAgent,
        `evict-fiber-managed-${crypto.randomUUID()}`
      );
      const agent = stub as unknown as TestRunFiberAgent;

      // A managed fiber whose recovery hook returns {status: "completed"}.
      await agent.insertInterruptedManagedFiber(
        "evicted-managed-1",
        "managed-recovery-complete",
        { progress: 42 }
      );

      await evictDurableObject(stub);

      // After eviction the in-memory recovery log starts empty.
      expect(
        (
          (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[]
        ).length
      ).toBe(0);

      // Drive one alarm cycle (the path the platform uses post-eviction):
      // _checkRunFibers → onFiberRecovered → _scheduleNextAlarm.
      await agent.simulateAlarmCycle();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered.some((f) => f.id === "evicted-managed-1")).toBe(true);
      const ctx = recovered.find((f) => f.id === "evicted-managed-1");
      expect(ctx?.snapshot).toEqual({ progress: 42 });

      // The managed ledger row must be marked completed (recovery applied),
      // not left running.
      const inspection = await agent.inspectManagedFiber("evicted-managed-1");
      expect(inspection?.status).toBe("completed");
    });

    it("recovers concurrent interrupted fibers independently after eviction", async () => {
      const stub = await getAgentByName(
        env.TestRunFiberAgent,
        `evict-fiber-concurrent-${crypto.randomUUID()}`
      );
      const agent = stub as unknown as TestRunFiberAgent;

      await agent.insertInterruptedFiber("evict-multi-a", "task-a", {
        which: "a"
      });
      await agent.insertInterruptedFiber("evict-multi-b", "task-b", {
        which: "b"
      });
      expect(await agent.getRunningFiberCount()).toBe(2);

      await evictDurableObject(stub);

      // Both rows survive; in-memory recovery state is fresh.
      expect(await agent.getRunningFiberCount()).toBe(2);
      expect(
        (
          (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[]
        ).length
      ).toBe(0);

      await agent.triggerRecoveryCheck();

      const recovered =
        (await agent.getRecoveredFibers()) as unknown as FiberRecoveryContext[];
      expect(recovered.length).toBe(2);
      expect(recovered.map((f) => f.id).sort()).toEqual([
        "evict-multi-a",
        "evict-multi-b"
      ]);
      expect(await agent.getRunningFiberCount()).toBe(0);
    });
  });
});

async function getKeepAliveRefs(
  stub: DurableObjectStub<TestKeepAliveAgent>
): Promise<number> {
  return runInDurableObject(stub, (instance) => instance._keepAliveRefs);
}
