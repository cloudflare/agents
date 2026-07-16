/**
 * Ported from ORIGINAL Agents:
 * - packages/agents/src/tests/schedule.test.ts
 * - port date: 2026-07-15
 * Modifications:
 * - Re-pointed `agents` imports to `./compat.js`.
 * - Re-authored schedule fixtures against rebuild `Think` + hostAgent.
 * - Dropped native-covered scheduler/storage-shape/alarm-retry cases with
 *   pointers to rebuild native suites.
 * - Kept original idempotency/onStart warning probes as [fidelity:adapter].
 */
// @ts-nocheck
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "./compat.js";
import type {
  TestP12OnStartScheduleExplicitFalseAgent,
  TestP12OnStartScheduleNoWarnAgent,
  TestP12OnStartScheduleWarnAgent,
  TestP12ScheduleAgent
} from "./fixtures/p12-scheduling-agents.js";

const p12Env = env as unknown as {
  TestP12ScheduleAgent: DurableObjectNamespace<TestP12ScheduleAgent>;
  TestP12OnStartScheduleWarnAgent: DurableObjectNamespace<TestP12OnStartScheduleWarnAgent>;
  TestP12OnStartScheduleExplicitFalseAgent: DurableObjectNamespace<TestP12OnStartScheduleExplicitFalseAgent>;
  TestP12OnStartScheduleNoWarnAgent: DurableObjectNamespace<TestP12OnStartScheduleNoWarnAgent>;
};

function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function scheduleAgent(
  prefix = "p12-schedule"
): Promise<DurableObjectStub<TestP12ScheduleAgent>> {
  return getAgentByName(p12Env.TestP12ScheduleAgent, uniqueName(prefix));
}

describe("schedule operations (ported)", () => {
  describe("cancelSchedule", () => {
    it.skip("should return false when cancelling a non-existent schedule", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — cancel returns false for absent schedules.

    it.skip("should return true when cancelling an existing schedule", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — cancel removes an existing schedule and returns true.
  });

  describe("getSchedule", () => {
    it.skip("should return undefined when getting a non-existent schedule", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — get returns undefined for unknown schedule ids.

    it.skip("should return schedule when getting an existing schedule", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — created schedules can be retrieved by id with callback.

    it.skip("should not expose internal storage columns on returned schedules", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — public schedules omit internal attempts/bookkeeping fields.
  });

  describe("scheduleEvery (interval scheduling)", () => {
    it.skip("should create an interval schedule with correct type", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — interval schedules store interval spec and callback.

    it.skip("should cancel an interval schedule", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — cancel removes interval schedules.

    it.skip("should filter schedules by interval type", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — list filters by schedule kind.

    it.skip("should persist interval schedule after callback throws", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — recurring schedules survive dispatcher failures.

    it.skip("should reset running flag to 0 after interval execution completes", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — rebuild has no old running column; recurring dispatch re-arms after execution.

    it.skip("should skip execution when running flag is already set (concurrent prevention)", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — rebuild scheduler processes due alarm work sequentially without old running-flag rows.

    it.skip("should force-reset hung interval schedule after 30 seconds", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — old hung-running-row recovery is replaced by retry/error scheduling semantics.

    it.skip("should handle legacy schedules with NULL execution_started_at", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — rebuild has no legacy execution_started_at column or migration path.
  });

  describe("schedule() onStart() warning", () => {
    it("should warn when schedule() is called inside onStart() without idempotent", async () => {
      const agentStub = await getAgentByName(
        p12Env.TestP12OnStartScheduleWarnAgent,
        uniqueName("onstart-warn-test")
      );

      const warned = await agentStub.wasWarnedFor("maintenanceCallback");
      expect(warned).toBe(true);

      const count = await agentStub.getScheduleCount();
      expect(count).toBe(1);
    });

    it("should not warn when schedule() is called inside onStart() with idempotent: false (explicit opt-out)", async () => {
      const agentStub = await getAgentByName(
        p12Env.TestP12OnStartScheduleExplicitFalseAgent,
        uniqueName("onstart-explicit-false-test")
      );

      const warned = await agentStub.wasWarnedFor("maintenanceCallback");
      expect(warned).toBe(false);
    });

    it("should not warn when schedule() is called inside onStart() with idempotent", async () => {
      const agentStub = await getAgentByName(
        p12Env.TestP12OnStartScheduleNoWarnAgent,
        uniqueName("onstart-no-warn-test")
      );

      const warned = await agentStub.wasWarnedFor("maintenanceCallback");
      expect(warned).toBe(false);

      const count = await agentStub.getScheduleCount();
      expect(count).toBe(1);
    });
  });

  describe("schedule() cron idempotency (default)", () => {
    it("should return existing schedule when called with same cron, callback, and payload", async () => {
      const agentStub = await scheduleAgent("cron-idempotent-same-args-test");

      const firstId = await agentStub.createCronSchedule("0 * * * *");
      const secondId = await agentStub.createCronSchedule("0 * * * *");

      expect(secondId).toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "cron",
          "cronCallback"
        )
      ).toBe(1);
    });

    it("should not create duplicates when called many times (simulating repeated onStart)", async () => {
      const agentStub = await scheduleAgent("cron-idempotent-repeated-test");

      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await agentStub.createCronSchedule("*/5 * * * *"));
      }

      expect([...new Set(ids)].length).toBe(1);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "cron",
          "cronCallback"
        )
      ).toBe(1);
    });

    it("should create a new row when cron expression differs", async () => {
      const agentStub = await scheduleAgent(
        "cron-idempotent-different-cron-test"
      );

      const firstId = await agentStub.createCronSchedule("0 * * * *");
      const secondId = await agentStub.createCronSchedule("30 * * * *");

      expect(secondId).not.toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "cron",
          "cronCallback"
        )
      ).toBe(2);
    });

    it("should create a new row when payload differs", async () => {
      const agentStub = await scheduleAgent(
        "cron-idempotent-different-payload-test"
      );

      const firstId = await agentStub.createCronScheduleWithPayload(
        "0 * * * *",
        "foo"
      );
      const secondId = await agentStub.createCronScheduleWithPayload(
        "0 * * * *",
        "bar"
      );

      expect(secondId).not.toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "cron",
          "cronCallback"
        )
      ).toBe(2);
    });

    it("should allow duplicate cron rows when idempotent is explicitly false", async () => {
      const agentStub = await scheduleAgent("cron-non-idempotent-test");

      const firstId =
        await agentStub.createCronScheduleNonIdempotent("0 * * * *");
      const secondId =
        await agentStub.createCronScheduleNonIdempotent("0 * * * *");

      expect(secondId).not.toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "cron",
          "cronCallback"
        )
      ).toBe(2);
    });
  });

  describe("schedule() delayed/scheduled idempotency (opt-in)", () => {
    it("should return existing delayed schedule when idempotent is true", async () => {
      const agentStub = await scheduleAgent("delayed-idempotent-test");

      const firstId = await agentStub.createIdempotentDelayedSchedule(60);
      const secondId = await agentStub.createIdempotentDelayedSchedule(60);

      expect(secondId).toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "delayed",
          "testCallback"
        )
      ).toBe(1);
    });

    it("should not create duplicates across many calls (simulating crash loop)", async () => {
      const agentStub = await scheduleAgent(
        "delayed-idempotent-crash-loop-test"
      );

      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push(await agentStub.createIdempotentDelayedSchedule(60));
      }

      expect([...new Set(ids)].length).toBe(1);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "delayed",
          "testCallback"
        )
      ).toBe(1);
    });

    it("should create separate rows for different payloads even with idempotent", async () => {
      const agentStub = await scheduleAgent(
        "delayed-idempotent-different-payload-test"
      );

      const firstId =
        await agentStub.createIdempotentDelayedScheduleWithPayload(60, "alice");
      const secondId =
        await agentStub.createIdempotentDelayedScheduleWithPayload(60, "bob");

      expect(secondId).not.toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "delayed",
          "testCallback"
        )
      ).toBe(2);
    });

    it("should still create duplicates when idempotent is not set (default)", async () => {
      const agentStub = await scheduleAgent(
        "delayed-non-idempotent-default-test"
      );

      const firstId = await agentStub.createSchedule(60);
      const secondId = await agentStub.createSchedule(60);

      expect(secondId).not.toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "delayed",
          "testCallback"
        )
      ).toBe(2);
    });

    it("should return existing scheduled (Date) schedule when idempotent is true", async () => {
      const agentStub = await scheduleAgent("scheduled-idempotent-test");

      const futureMs = Date.now() + 60_000;
      const firstId =
        await agentStub.createIdempotentScheduledSchedule(futureMs);
      const secondId = await agentStub.createIdempotentScheduledSchedule(
        futureMs + 30_000
      );

      expect(secondId).toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "scheduled",
          "testCallback"
        )
      ).toBe(1);
    });
  });

  describe("alarm() duplicate schedule warning", () => {
    it.skip("should warn when processing many stale one-shot rows for the same callback", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — duplicate callback warning is asserted at create/list level, not old stale-row alarm SQL.

    it.skip("should not warn when stale one-shot count is below threshold", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — duplicate callback threshold non-warning is asserted natively.
  });

  describe("scheduleEvery idempotency", () => {
    it("should return existing schedule when called with same callback and interval", async () => {
      const agentStub = await scheduleAgent("idempotent-same-args-test");

      const firstId = await agentStub.createIntervalSchedule(30);
      const secondId = await agentStub.createIntervalSchedule(30);

      expect(secondId).toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "interval",
          "intervalCallback"
        )
      ).toBe(1);
    });

    it("should re-arm a lost alarm when idempotency returns an existing interval schedule", async () => {
      const agentStub = await scheduleAgent("idempotent-rearm-lost-alarm-test");

      const firstId = await agentStub.createIntervalSchedule(30);
      await agentStub.clearStoredAlarm();
      expect(await agentStub.getStoredAlarm()).toBeNull();

      const { alarm: rearmedAlarm, id: secondId } =
        await agentStub.createIntervalScheduleAndReadAlarm(30);
      expect(secondId).toBe(firstId);
      expect(rearmedAlarm).not.toBeNull();
    });

    it.skip("should immediately re-arm an overdue interval schedule when idempotency returns the existing row", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — alarm re-arm to earliest pending schedule is covered without old overdue-row SQL.

    it("should return existing schedule when called with same callback, interval, and payload", async () => {
      const agentStub = await scheduleAgent("idempotent-same-payload-test");

      const firstId = await agentStub.createIntervalScheduleWithPayload(
        30,
        "hello"
      );
      const secondId = await agentStub.createIntervalScheduleWithPayload(
        30,
        "hello"
      );

      expect(secondId).toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "interval",
          "intervalCallback"
        )
      ).toBe(1);
    });

    it("should create a new row when interval changes for same callback", async () => {
      const agentStub = await scheduleAgent("idempotent-interval-change-test");

      const firstId = await agentStub.createIntervalSchedule(30);
      const secondId = await agentStub.createIntervalSchedule(60);

      expect(secondId).not.toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "interval",
          "intervalCallback"
        )
      ).toBe(2);
      expect(
        (await agentStub.getStoredScheduleById(secondId))?.intervalSeconds
      ).toBe(60);
      expect(
        (await agentStub.getStoredScheduleById(firstId))?.intervalSeconds
      ).toBe(30);
    });

    it("should create a new row when payload changes for same callback", async () => {
      const agentStub = await scheduleAgent("idempotent-payload-change-test");

      const firstId = await agentStub.createIntervalScheduleWithPayload(
        30,
        "foo"
      );
      const secondId = await agentStub.createIntervalScheduleWithPayload(
        30,
        "bar"
      );

      expect(secondId).not.toBe(firstId);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "interval",
          "intervalCallback"
        )
      ).toBe(2);
      expect((await agentStub.getStoredScheduleById(firstId))?.payload).toBe(
        "foo"
      );
      expect((await agentStub.getStoredScheduleById(secondId))?.payload).toBe(
        "bar"
      );
    });

    it("should allow different callbacks to have their own interval schedules", async () => {
      const agentStub = await scheduleAgent(
        "idempotent-different-callbacks-test"
      );

      const firstId = await agentStub.createIntervalSchedule(30);
      const secondId = await agentStub.createSecondIntervalSchedule(30);

      expect(secondId).not.toBe(firstId);
      expect((await agentStub.getSchedulesByType("interval")).length).toBe(2);
    });

    it("should not create duplicates when called many times (simulating repeated onStart)", async () => {
      const agentStub = await scheduleAgent("idempotent-repeated-calls-test");

      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await agentStub.createIntervalSchedule(30));
      }

      expect([...new Set(ids)].length).toBe(1);
      expect(
        await agentStub.getScheduleCountByTypeAndCallback(
          "interval",
          "intervalCallback"
        )
      ).toBe(1);
    });
  });

  describe("one-shot defer on a superseded-isolate error", () => {
    it.skip('preserves the row + rejects alarm for "reset because its code was updated" (deploy bounce)', () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — once-schedule dispatcher failure/error deletion is covered; old platform-supersede defer matcher is not part of rebuild scheduler.

    it.skip('preserves the row + rejects alarm for "This script has been upgraded" (superseded script)', () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — old platform-supersede defer matcher is replaced by explicit scheduler retry/error policy.

    it.skip("swallows + deletes the row for an ordinary (non-supersede) error", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — failing once schedule with no retry policy emits error and deletes the schedule.

    it.skip("does NOT treat an ordinary error that merely mentions an upgraded script as a supersede", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — supersede phrase matching is old boundary behavior; ordinary once failure deletion is covered.
  });

  describe("alarm memory-limit circuit breaker (#1825)", () => {
    it.skip("under budget: swallows the alarm and preserves the row (backed off)", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — rebuild models retry policy explicitly instead of old memory-limit alarm breaker.

    it.skip("matches a truncated memory-limit surfacing too", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — old memory-limit message matcher is not part of rebuild scheduler semantics.

    it.skip("at the strike budget: seals + purges the looping row so the loop stops", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — max-attempt retry exhaustion emits schedule:error and deletes once schedules.

    it.skip("a clean alarm resets the strike counter (consecutive, not lifetime)", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — retry attempts reset after a successful recurring dispatch.

    it.skip("a non-memory error still rejects/ swallows as before (breaker is OOM-only)", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — ordinary schedule failure and retry/error behavior are asserted natively.
  });

  describe("one-shot defer on retry exhaustion of a platform transient (#1730)", () => {
    it.skip('defers "Network connection lost." on exhaustion instead of consuming the row', () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — rebuild retry exhaustion behavior is expressed by retry policy and schedule:error.

    it.skip("defers the SqlError shape (wrapped, retryable flag lost) on exhaustion", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — old platform transient classification is not part of rebuild scheduler.

    it.skip("defers a retryable-flagged platform error on exhaustion", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — retry policy max-attempt behavior is covered without platform error flags.

    it.skip('still retries "Network connection lost." in-process first (a momentary blip heals without deferral)', () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — retry then success resumes normal scheduling natively.

    it.skip("still abandons the row when the FINAL error is an application error", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — final retry exhaustion emits error and consumes failing once schedule.

    it.skip("still abandons the row on exhaustion of a pure application error", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — repeated application failure through maxAttempts is covered.

    it.skip("a supersede error mid-sequence still defers IMMEDIATELY without burning the remaining budget", () => {});
    // dropped: native src/domain/runtime/scheduling/scheduler.test.ts — old supersede-specific immediate deferral is outside rebuild scheduler semantics.
  });
});
