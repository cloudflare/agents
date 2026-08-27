import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Lifecycle alarm arbitration", () => {
  it("dispatches capability alarm hooks before the host alarm hook", async () => {
    const name = crypto.randomUUID();
    const stub = env.PlainLifecycleObject.getByName(name);
    await stub.startFromRpc({ label: "rpc" });
    await stub.scheduleAlarm();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getEvents()).toEqual([
      "capability:start:rpc",
      "host:start:rpc",
      "capability:alarm",
      "host:alarm"
    ]);
  });

  it("owns one physical alarm across capability and host contributions", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    const now = Date.now();

    expect(
      await stub.setAlarmContributions(now + 30_000, now + 20_000, now + 40_000)
    ).toBe(now + 20_000);
    expect(
      await stub.setAlarmContributions(null, now + 30_000, now + 10_000)
    ).toBe(now + 10_000);
    expect(
      await stub.setAlarmContributions(now + 5_000, null, null, now + 40_000)
    ).toBe(now + 40_000);
    expect(await stub.setAlarmContributions(null, null, null)).toBeNull();

    const contexts = await stub.getAlarmContributionContexts();
    expect(contexts.capability.length).toBeGreaterThan(0);
    expect(contexts.capability.every((hasHost) => !hasHost)).toBe(true);
    expect(contexts.host.length).toBeGreaterThan(0);
    expect(contexts.host.every((hasHost) => hasHost)).toBe(true);
  });

  it("applies alarm rearm requests made during capability startup", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    const before = Date.now();
    const alarm = await stub.startWithAlarmContribution();

    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeGreaterThanOrEqual(before + 59_000);
    expect(alarm as number).toBeLessThanOrEqual(Date.now() + 61_000);
  });
});
