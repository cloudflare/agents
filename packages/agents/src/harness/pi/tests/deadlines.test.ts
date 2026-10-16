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

  it("keeps pi paused while every live task sleeps until a known deadline", async () => {
    const name = crypto.randomUUID();
    await stub(name).sleepUntil(Date.now() + 60_000);
    const object = await restart(name);
    await beat(object);

    // No pi task runs, so none holds a timer that blocks hibernation.
    expect(await object.scheduling()).toBe("paused");
  });

  it("resumes pi when the deadline arrives", async () => {
    const name = crypto.randomUUID();
    // Past the test's 5 s sleep threshold, but not by much.
    await stub(name).sleepUntil(Date.now() + 7_000);
    const object = await restart(name);
    expect(await object.scheduling()).toBe("paused");

    // The wake's alarm, not any request, brings the task back.
    for (let i = 0; i < 100; i++) {
      if ((await object.liveTasks()) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await object.liveTasks()).toBe(0);
  });

  it("resumes pi for new input", async () => {
    const name = crypto.randomUUID();
    await stub(name).sleepUntil(Date.now() + 60_000);
    const object = await restart(name);
    expect(await object.scheduling()).toBe("paused");

    await object.submit("hello");
    expect(await object.scheduling()).toBe("running");
  });

  it("resumes pi when a task is committed while it is paused", async () => {
    const name = crypto.randomUUID();
    await stub(name).sleepUntil(Date.now() + 60_000);
    const object = await restart(name);
    expect(await object.scheduling()).toBe("paused");

    // Committed directly, with no submit and no wake of its own.
    await object.sleepUntil(Date.now() + 200);
    await eventually(
      () => object.liveTasks(),
      (live) => live === 1
    );
  });

  it("resumes pi at startup as before without wakeAt", async () => {
    const name = crypto.randomUUID();
    await env.PI_WAKE_TEST.getByName(name).sleepUntil(Date.now() + 60_000);
    await abortAllDurableObjects();
    const object = env.PI_WAKE_TEST.getByName(name);
    await object.start();
    expect(await object.scheduling()).toBe("running");
  });
});
