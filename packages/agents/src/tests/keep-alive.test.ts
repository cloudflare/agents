import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { TestKeepAliveAgent } from "./agents/keep-alive";

describe("keepAlive", () => {
  it("should increment _keepAliveRefs when started", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "create-heartbeat"
    );

    expect(await getKeepAliveRefs(agent)).toBe(0);

    await agent.startKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(1);
  });

  it("should not create any schedule rows", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "no-schedule-rows"
    );

    await agent.startKeepAlive();

    const scheduleCount = (await agent.getScheduleCount()) as unknown as number;
    expect(scheduleCount).toBe(0);
  });

  it("should decrement refs when disposed", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "dispose-heartbeat"
    );

    await agent.startKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(1);

    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);
  });

  it("should be idempotent when disposed multiple times", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "double-dispose"
    );

    await agent.startKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(1);

    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);

    // Second dispose is a no-op (doesn't go negative)
    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);
  });

  it("keepAliveWhile should return the function result and clean up", async () => {
    const agent = await getAgentByName(env.TestKeepAliveAgent, "while-success");

    expect(await getKeepAliveRefs(agent)).toBe(0);

    const result = await agent.runWithKeepAliveWhile();
    expect(result).toBe("completed");

    expect(await getKeepAliveRefs(agent)).toBe(0);
  });

  it("keepAliveWhile should clean up even when the function throws", async () => {
    const agent = await getAgentByName(env.TestKeepAliveAgent, "while-error");

    expect(await getKeepAliveRefs(agent)).toBe(0);

    const result = await agent.runWithKeepAliveWhileError();
    expect(result).toBe("caught");

    expect(await getKeepAliveRefs(agent)).toBe(0);
  });

  it("should support multiple concurrent keepAlive calls", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "multiple-keepalive"
    );

    await agent.startKeepAlive();
    await agent.startKeepAlive();

    expect(await getKeepAliveRefs(agent)).toBe(2);

    // Disposing one should decrement, not clear
    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(1);

    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);
  });

  it("refs should never go below zero", async () => {
    const agent = await getAgentByName(
      env.TestKeepAliveAgent,
      "no-negative-refs"
    );

    // Dispose without ever starting
    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);

    // Start once, dispose twice
    await agent.startKeepAlive();
    await agent.stopKeepAlive();
    await agent.stopKeepAlive();
    expect(await getKeepAliveRefs(agent)).toBe(0);
  });

  // Regression coverage for #1704: a short-lived keepAlive must not leave a
  // stale `now + keepAliveIntervalMs` heartbeat armed once the lease is gone.
  describe("alarm rescheduling on dispose (#1704)", () => {
    it("arms a heartbeat alarm while a lease is held", async () => {
      const agent = await getAgentByName(env.TestKeepAliveAgent, "arm-alarm");

      expect(await agent.getCurrentAlarm()).toBeNull();

      const before = Date.now();
      await agent.startKeepAlive();

      const alarm = await agent.getCurrentAlarm();
      expect(alarm).not.toBeNull();
      // Capped at now + keepAliveIntervalMs (default 30s) with slack.
      expect(alarm as number).toBeGreaterThan(before);
      expect(alarm as number).toBeLessThanOrEqual(before + 30_000 + 5_000);
    });

    it("clears the stale heartbeat when the last lease is disposed", async () => {
      const agent = await getAgentByName(env.TestKeepAliveAgent, "clear-alarm");

      await agent.startKeepAlive();
      expect(await agent.getCurrentAlarm()).not.toBeNull();

      await agent.stopKeepAlive();

      // With no pending schedules, the heartbeat must be pulled back.
      expect(await agent.getCurrentAlarm()).toBeNull();
    });

    it("keeps the alarm armed until the final concurrent lease is released", async () => {
      const agent = await getAgentByName(
        env.TestKeepAliveAgent,
        "concurrent-alarm"
      );

      await agent.startKeepAlive();
      await agent.startKeepAlive();
      expect(await agent.getCurrentAlarm()).not.toBeNull();

      // Releasing one of two leases must NOT clear the heartbeat.
      await agent.stopKeepAlive();
      expect(await agent.getCurrentAlarm()).not.toBeNull();

      // Releasing the last lease clears it.
      await agent.stopKeepAlive();
      expect(await agent.getCurrentAlarm()).toBeNull();
    });

    it("clears the heartbeat after keepAliveWhile completes", async () => {
      const agent = await getAgentByName(
        env.TestKeepAliveAgent,
        "while-clears-alarm"
      );

      expect(await agent.getCurrentAlarm()).toBeNull();

      const result = await agent.runWithKeepAliveWhile();
      expect(result).toBe("completed");

      expect(await getKeepAliveRefs(agent)).toBe(0);
      expect(await agent.getCurrentAlarm()).toBeNull();
    });

    it("re-acquiring after dispose keeps the heartbeat armed (no clobber)", async () => {
      const agent = await getAgentByName(
        env.TestKeepAliveAgent,
        "reacquire-alarm"
      );

      // Acquire then release: the dispose fire-and-forgets a reschedule that
      // would clear the alarm. Immediately re-acquiring must win, because the
      // reschedule reads the live ref count rather than a stale snapshot.
      await agent.startKeepAlive();
      await agent.stopKeepAlive();
      await agent.startKeepAlive();

      expect(await getKeepAliveRefs(agent)).toBe(1);
      expect(await agent.getCurrentAlarm()).not.toBeNull();
    });

    it("falls back to the next legitimate schedule instead of the heartbeat", async () => {
      const agent = await getAgentByName(
        env.TestKeepAliveAgent,
        "fallback-alarm"
      );

      // A real task far beyond the keepAlive interval.
      await agent.scheduleFarFutureTask(600);
      const before = Date.now();

      await agent.startKeepAlive();
      // While the lease is held, the heartbeat caps the alarm to ~30s.
      const cappedAlarm = await agent.getCurrentAlarm();
      expect(cappedAlarm as number).toBeLessThanOrEqual(
        before + 30_000 + 5_000
      );

      await agent.stopKeepAlive();

      // After dispose, the alarm is recomputed to the real task, not cleared
      // and not left at the heartbeat interval.
      const alarm = await agent.getCurrentAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm as number).toBeGreaterThan(before + 60_000);
    });
  });
});

async function getKeepAliveRefs(
  stub: DurableObjectStub<TestKeepAliveAgent>
): Promise<number> {
  return runInDurableObject(stub, (instance) => {
    return instance._keepAliveRefs;
  });
}
