import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GENERATION_RETRY_DELAY_MS, WAIT_BUDGET_MS } from "./wake-fixture";
import { TEST_TIMING } from "./timing";

function stub(name: string) {
  return env.PI_WAKE_TEST.getByName(name);
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean
): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition was never met");
}

describe("PiHarness wake deadlines", () => {
  it("does not park the wake on a generation retry while a background task is due sooner", async () => {
    const name = crypto.randomUUID();
    let object = stub(name);
    const backgroundDueAt = Date.now() + 10_000;
    await object.sleepUntil(backgroundDueAt);
    await object.submit("fail once");
    const retryAt = await eventually(
      () => object.retryAt(),
      (at) => at !== undefined
    );
    expect(retryAt).toBeGreaterThan(backgroundDueAt);

    // A crash loses pi's in-memory timers. Only the wake job brings the
    // object back for the background task.
    await abortAllDurableObjects();
    object = stub(name);
    await runDurableObjectAlarm(object);

    const wakeAt = await eventually(
      () => object.wakeJobTime(),
      (time) => time !== null && time > Date.now()
    );
    expect(wakeAt).toBeLessThanOrEqual(
      Math.min(backgroundDueAt, Date.now() + TEST_TIMING.heartbeatMs + 1_000)
    );
    expect(wakeAt).toBeLessThan(retryAt!);
    expect(retryAt! - Date.now()).toBeGreaterThan(
      GENERATION_RETRY_DELAY_MS / 2
    );
  });

  it("keeps a session's wake job when its dispatch keeps failing while pi has work", async () => {
    const name = crypto.randomUUID();
    let object = stub(name);
    await object.sleepUntil(Date.now() + 60_000);
    // Startup gives every session with live work a wake job.
    await abortAllDurableObjects();
    object = stub(name);
    await object.failInspect(true);

    // Each alarm dispatch tries the job three times before giving up.
    await eventually(
      async () => {
        await runDurableObjectAlarm(object);
        return object.inspectFailures();
      },
      (failures) => failures >= 3
    );

    const wakeAt = await object.wakeJobTime();
    expect(wakeAt).not.toBeNull();
    expect(wakeAt!).toBeGreaterThan(Date.now());

    // Once pi answers again, the wake carries on.
    await object.failInspect(false);
    await eventually(
      async () => {
        await runDurableObjectAlarm(object);
        return object.wakeJobTime();
      },
      (time) => time !== null && time > Date.now()
    );
  });

  it("reports a memory-limit reset in a session's idle wait to the alarm breaker", async () => {
    const name = crypto.randomUUID();
    let object = stub(name);
    // Foreground work that is not a generation: the wake waits on it.
    await object.sleepUntil(Date.now() + 60_000, { background: false });
    await object.failIdleWait(
      "Durable Object's isolate exceeded its memory limit and was reset."
    );
    await abortAllDurableObjects();
    object = stub(name);
    await object.start();

    // The breaker resets the isolate after recording the strike, which can
    // surface from the alarm itself.
    await runDurableObjectAlarm(object).catch(() => false);
    expect(
      await eventually(
        () =>
          stub(name)
            .memoryLimitStrikes()
            .catch(() => 0),
        (strikes) => strikes > 0
      )
    ).toBe(1);
  });

  it("does not count a wake's own wait running out as a failure", async () => {
    const name = crypto.randomUUID();
    let object = stub(name);
    await object.sleepUntil(Date.now() + 60_000, { background: false });
    await abortAllDurableObjects();
    object = stub(name);
    await object.start();
    await runDurableObjectAlarm(object);
    await new Promise((resolve) => setTimeout(resolve, WAIT_BUDGET_MS * 3));

    expect(await object.memoryLimitStrikes()).toBe(0);
    expect(await object.wakeJobTime()).not.toBeNull();
  });

  it("parks the wake on a generation retry when the generation is the only live work", async () => {
    const name = crypto.randomUUID();
    let object = stub(name);
    await object.submit("fail once");
    const retryAt = await eventually(
      () => object.retryAt(),
      (at) => at !== undefined
    );

    await abortAllDurableObjects();
    object = stub(name);
    await runDurableObjectAlarm(object);

    expect(
      await eventually(
        () => object.wakeJobTime(),
        (time) => time === retryAt
      )
    ).toBe(retryAt);
  });
});
