import { describe, expect, it } from "vitest";
import { KeepAlive } from "../../lifecycle";
import { withCapabilityHarness } from "../shared/capability-harness";

/**
 * The KeepAlive capability on a bare Durable Object with a real Lifecycle.
 * Agent-level behaviour (sub-agents, the alarm next to schedules) is in
 * ../keep-alive.test.ts and ../sub-agent.test.ts.
 */

function heartbeat(storage: DurableObjectStorage): number | null {
  const [row] = storage.sql
    .exec<{ time: number }>(
      "SELECT time FROM cf_agents_jobs WHERE capability = 'keep-alive'"
    )
    .toArray();
  return row?.time ?? null;
}

describe("KeepAlive capability", () => {
  it("keeps one heartbeat job while any hold is open", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { capability: keepAlive } = install(
        new KeepAlive({ intervalMs: 5_000 })
      );
      const before = Date.now();
      const first = await keepAlive.acquire();
      const second = await keepAlive.acquire();
      expect(keepAlive.holds).toBe(2);
      const time = heartbeat(storage);
      expect(time).toBeGreaterThanOrEqual(before + 5_000);
      expect(time).toBeLessThanOrEqual(Date.now() + 5_000);
      expect(await storage.getAlarm()).toBe(time);

      first();
      first();
      expect(keepAlive.holds).toBe(1);
      expect(heartbeat(storage)).toBe(time);

      second();
      expect(keepAlive.holds).toBe(0);
      expect(heartbeat(storage)).toBeNull();
    });
  });

  it("re-arms the heartbeat while held and lets it go once released", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability: keepAlive } = install(
        new KeepAlive({ intervalMs: 5_000 })
      );
      const job = {
        job: {} as never,
        attempt: 1
      };
      const release = await keepAlive.acquire();
      const outcome = keepAlive.onJob(job);
      expect(outcome).toEqual({ rescheduleAt: expect.any(Number) });
      release();
      expect(keepAlive.onJob(job)).toBeUndefined();
    });
  });

  it("releases the hold when run() settles, even on a throw", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { capability: keepAlive } = install(new KeepAlive());
      expect(await keepAlive.run(async () => keepAlive.holds)).toBe(1);
      await expect(
        keepAlive.run(async () => {
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      expect(keepAlive.holds).toBe(0);
      expect(heartbeat(storage)).toBeNull();
    });
  });

  it("does not count a hold whose heartbeat could not be armed", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { capability: keepAlive, lifecycle } = install(
        new KeepAlive({ intervalMs: 5_000 })
      );
      // Job ids are one namespace across owners: another owner's job under
      // KeepAlive's id makes its push throw.
      await lifecycle.jobs.push({
        id: "keep-alive:heartbeat",
        fn: "mine",
        time: Date.now() + 60_000
      });
      await expect(keepAlive.acquire()).rejects.toThrow(/already belongs/);
      expect(keepAlive.holds).toBe(0);

      // Once the id is free, the next hold arms the heartbeat again.
      await lifecycle.jobs.cancel("keep-alive:heartbeat");
      const release = await keepAlive.acquire();
      expect(keepAlive.holds).toBe(1);
      expect(heartbeat(storage)).not.toBeNull();
      release();
    });
  });

  it("does not collide with a host job named heartbeat", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { capability: keepAlive, lifecycle } = install(new KeepAlive());
      await lifecycle.jobs.push({
        id: "heartbeat",
        fn: "mine",
        time: Date.now() + 60_000
      });
      const release = await keepAlive.acquire();
      expect(keepAlive.holds).toBe(1);
      release();
    });
  });
});
