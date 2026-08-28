import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

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
});
