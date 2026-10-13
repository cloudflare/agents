import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function stub(name: string) {
  return env.PI_DEADLINE_TEST.getByName(name);
}

/** A crash leaves only the wake job; startup rebuilds it, due now. */
async function restart(name: string) {
  await abortAllDurableObjects();
  const object = stub(name);
  await object.start();
  return object;
}

/** Run the session's wake now and read when it is due next. */
async function beat(object: ReturnType<typeof stub>) {
  await object.makeWakeDue();
  await runDurableObjectAlarm(object);
  return object.wakeJobTime();
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

describe("PiHarness wakeAt", () => {
  it("sleeps until a task's reported deadline instead of polling it", async () => {
    const name = crypto.randomUUID();
    const runAt = Date.now() + 60_000;
    await stub(name).sleepUntil(runAt);
    const object = await restart(name);

    expect(await beat(object)).toBe(runAt);
  });

  it("wakes for the earliest deadline across a generation retry and a task", async () => {
    const name = crypto.randomUUID();
    let object = stub(name);
    const runAt = Date.now() + 20_000;
    await object.sleepUntil(runAt);
    await object.submit("fail once");
    const retryAt = await eventually(
      () => object.retryAt(),
      (at) => at !== undefined
    );
    expect(retryAt).toBeGreaterThan(runAt);

    object = await restart(name);
    expect(await beat(object)).toBe(runAt);
  });
});
