import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { captureDiagnosticsEvents } from "../shared/diagnostics-capture";

describe("Lifecycle job queue", () => {
  it("drives due capability and host jobs before the host alarm hook", async () => {
    const name = crypto.randomUUID();
    const stub = env.PlainLifecycleObject.getByName(name);
    await stub.startFromRpc({ label: "rpc" });
    await stub.pushDueProbeJob("tick");
    await stub.pushDueHostJob("beat");

    // Backdated jobs arm an imminent alarm, which the workers pool
    // auto-fires; poll for the observable effect instead of firing manually.
    await vi.waitFor(
      async () => {
        const events = await stub.getEvents();
        expect(events).toContain("capability:job:tick");
        expect(events).toContain("host:job:beat");
        expect(events).toContain("host:alarm");
      },
      { timeout: 10_000 }
    );

    const events = await stub.getEvents();
    expect(events.indexOf("capability:job:tick")).toBeLessThan(
      events.indexOf("host:alarm")
    );
    expect(events.indexOf("host:job:beat")).toBeLessThan(
      events.indexOf("host:alarm")
    );

    // Capability jobs run outside ambient host context; host jobs run
    // inside the host invocation boundary.
    const contexts = await stub.getJobContexts();
    expect(contexts.capability.length).toBeGreaterThan(0);
    expect(contexts.capability.every((hasHost) => !hasHost)).toBe(true);
    expect(contexts.host.length).toBeGreaterThan(0);
    expect(contexts.host.every((hasHost) => hasHost)).toBe(true);
  });

  it("derives one physical alarm from queue state", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    const now = Date.now();

    expect(
      await stub.setQueueJobs({
        capabilityTimes: [now + 30_000, now + 20_000],
        hostTime: now + 40_000
      })
    ).toBe(now + 20_000);
    expect(
      await stub.setQueueJobs({
        capabilityTimes: [now + 30_000],
        hostTime: now + 10_000
      })
    ).toBe(now + 10_000);
    // An exclusive job suppresses ordinary candidates.
    expect(
      await stub.setQueueJobs({
        capabilityTimes: [now + 5_000],
        exclusiveTime: now + 40_000
      })
    ).toBe(now + 40_000);
    // An empty queue deletes the physical alarm.
    expect(await stub.setQueueJobs({})).toBeNull();
  });

  it("applies job pushes made during capability startup", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    const before = Date.now();
    const alarm = await stub.startWithAlarmContribution();

    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeGreaterThanOrEqual(before + 59_000);
    expect(alarm as number).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("applies a sync push made during capability startup", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    const before = Date.now();
    // `pushSync` re-arms nothing itself; during startup the deferred,
    // coalesced re-arm has to cover it, with no explicit rearm call.
    const alarm = await stub.startWithSyncAlarmContribution();

    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeGreaterThanOrEqual(before + 59_000);
    expect(alarm as number).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("commits a sync push with the caller's transaction, then re-arms", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    const time = Date.now() + 60_000;
    const armed = await stub.pushJobInTransaction({
      id: "tx-job",
      marker: "committed",
      time
    });

    expect(armed.error).toBeNull();
    expect(armed.markers).toEqual(["committed"]);
    expect(armed.jobTime).toBe(time);
    // The defining property of the sync verbs: the row lands, the physical
    // alarm does not move until the caller's own `rearm()`.
    expect(armed.alarmBeforeRearm).toBeNull();
    expect(armed.alarm).toBe(time);

    // The same push backdated drives from the alarm loop like any other.
    const due = await stub.pushJobInTransaction({
      id: "tx-due",
      marker: "due",
      time: Date.now() - 1
    });
    expect(due.error).toBeNull();
    await vi.waitFor(
      async () => {
        expect(await stub.getEvents()).toContain("capability:job:tick");
      },
      { timeout: 10_000 }
    );
  });

  it("rolls a sync push back with the caller's transaction", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    const rolledBack = await stub.pushJobInTransaction({
      id: "tx-rollback",
      marker: "rolled-back",
      time: Date.now() + 60_000,
      throwInside: true
    });

    // The whole point: the caller's row and the job live or die together.
    expect(rolledBack.error).toBe("rolled back");
    expect(rolledBack.markers).toEqual([]);
    expect(rolledBack.jobTime).toBeNull();
    expect(rolledBack.alarmBeforeRearm).toBeNull();
    expect(rolledBack.alarm).toBeNull();
  });

  it("cancels inside the caller's transaction, then re-arms", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    const time = Date.now() + 60_000;
    expect(
      (
        await stub.pushJobInTransaction({
          id: "tx-cancel",
          marker: "cancel",
          time
        })
      ).alarm
    ).toBe(time);

    expect(await stub.cancelJobInTransaction("tx-cancel")).toEqual({
      cancelled: true,
      jobTime: null,
      // The cancel leaves the now-surplus alarm standing; `rearm()` clears
      // it, and until then it would only fire and find nothing due.
      alarmBeforeRearm: time,
      alarm: null
    });
  });

  it("keeps the queue usable after a rolled-back transaction created its table", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    // The read that decides whether to push is, on a fresh object, the call
    // that creates the job table — inside the caller's transaction. The
    // rollback takes the table with it, so nothing may cache it as present.
    const rolledBack = await stub.pushJobIfAbsentInTransaction({
      id: "tx-absent",
      time: Date.now() + 60_000,
      throwInside: true
    });
    expect(rolledBack).toEqual({ error: "rolled back", pushed: true });
    expect(await stub.getProbeJob("tx-absent")).toBeNull();

    const time = Date.now() + 60_000;
    expect(
      await stub.pushJobIfAbsentInTransaction({ id: "tx-absent", time })
    ).toEqual({ error: null, pushed: true });
    expect(await stub.getProbeJob("tx-absent")).toEqual({
      fn: "tick",
      time
    });
  });

  it("lets a same-id push made mid-dispatch survive the drive outcome", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    await stub.startFromRpc({ label: "rpc" });
    const futureTime = Date.now() + 120_000;
    await stub.armRepushProbeJob(futureTime);

    await vi.waitFor(
      async () => {
        expect(await stub.getEvents()).toContain("capability:job:repush");
      },
      { timeout: 10_000 }
    );

    // The handler completed (outcome: delete), but its mid-dispatch push is
    // newer durable intent — the job must survive at the pushed time.
    const survivor = await stub.getProbeJob("repush-probe");
    expect(survivor).toEqual({ fn: "tick", time: futureTime });
  });

  it("skips a due job's stale snapshot after an earlier dispatch retimed it", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    await stub.startFromRpc({ label: "rpc" });
    const futureTime = Date.now() + 120_000;
    await stub.armStaleSnapshotProbe(futureTime);

    await vi.waitFor(
      async () => {
        expect(await stub.getEvents()).toContain("capability:job:retime-other");
      },
      { timeout: 10_000 }
    );

    // The victim was due in the same batch, but the retimer moved it to the
    // future first: its stale snapshot must not have dispatched, and the
    // retimed job must survive untouched.
    expect(await stub.getEvents()).not.toContain("capability:job:tick");
    expect(await stub.getProbeJob("victim")).toEqual({
      fn: "tick",
      time: futureTime
    });
  });

  it("scopes job ids to their owner instead of clobbering across owners", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    await stub.startFromRpc({ label: "rpc" });

    const { error, probeJobTime } = await stub.pushForeignIdForTest();
    expect(error).toMatch(/already belongs to "job-probe"/);
    // The contested job is untouched: still the first owner's, at its time.
    expect(probeJobTime).not.toBeNull();
    expect(probeJobTime as number).toBeGreaterThan(Date.now() + 30_000);
  });

  it("warns and emits telemetry when one dispatch runs long", async () => {
    const name = crypto.randomUUID();
    const stub = env.PlainLifecycleObject.getByName(name);
    const capture = captureDiagnosticsEvents("agents:lifecycle", name);
    try {
      await stub.startFromRpc({ label: "rpc" });
      await stub.armSlowProbeJob();

      await vi.waitFor(
        async () => {
          expect(await stub.getEvents()).toContain("capability:job:slow");
          const slow = capture.events.find(
            (event) => event.type === "job:slow_dispatch"
          );
          expect(slow).toBeDefined();
          expect(slow?.payload).toMatchObject({
            capability: "job-probe",
            fn: "slow",
            id: "slow-probe"
          });
        },
        { timeout: 10_000 }
      );
    } finally {
      capture.stop();
    }
  });
});
