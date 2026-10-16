import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_HEARTBEAT_MS } from "./wake-fixture";
import { TEST_TIMING } from "./timing";

function stub(name: string) {
  return env.PI_WAKE_TEST.getByName(name);
}

/** How long a wake with `count` beats of backoff waits. */
function backoff(count: number): number {
  return Math.min(TEST_TIMING.heartbeatMs * 2 ** count, MAX_HEARTBEAT_MS);
}

/** Run the session's wake now and read when it is due next. */
async function beat(object: ReturnType<typeof stub>) {
  await object.makeWakeDue();
  await runDurableObjectAlarm(object);
  const now = Date.now();
  const time = await object.wakeJobTime();
  const state = await object.wakeState();
  return { delay: (time ?? 0) - now, state };
}

/** A crash leaves only the wake job; startup rebuilds it, due now. */
async function restart(name: string) {
  await abortAllDurableObjects();
  const object = stub(name);
  await object.start();
  return object;
}

describe("PiHarness dynamic heartbeat", () => {
  it("backs off a background-only session's wake while it makes no progress", async () => {
    const name = crypto.randomUUID();
    await stub(name).sleepUntil(Date.now() + 300_000);
    const object = await restart(name);

    let idle = -1;
    for (let i = 0; i < 6; i++) {
      const { delay, state } = await beat(object);
      expect(state?.idle).toBeGreaterThan(idle);
      idle = state!.idle!;
      expect(delay).toBeGreaterThan(backoff(idle) - 500);
      expect(delay).toBeLessThanOrEqual(backoff(idle) + 100);
    }
    expect(backoff(idle)).toBe(MAX_HEARTBEAT_MS);
  });

  it("keeps its backoff across a restart", async () => {
    const name = crypto.randomUUID();
    await stub(name).sleepUntil(Date.now() + 300_000);
    let object = await restart(name);
    for (let i = 0; i < 3; i++) await beat(object);
    const before = (await object.wakeState())!.idle!;

    object = await restart(name);
    const { state } = await beat(object);
    expect(state!.idle!).toBeGreaterThan(before);
  });

  it("returns to the base heartbeat when the session gets new input", async () => {
    const name = crypto.randomUUID();
    await stub(name).sleepUntil(Date.now() + 300_000);
    const object = await restart(name);
    for (let i = 0; i < 3; i++) await beat(object);
    expect((await object.wakeState())!.idle!).toBeGreaterThan(1);

    await object.submit("hello");
    // A beat that raced the submit may have stored a fresh, zero backoff.
    expect((await object.wakeState())?.idle ?? 0).toBe(0);
  });

  it("backs off a wake whose dispatch keeps failing", async () => {
    const name = crypto.randomUUID();
    // Background work, so no in-memory wait skips the failing dispatch.
    await stub(name).sleepUntil(Date.now() + 300_000);
    const object = await restart(name);
    await object.failInspect(true);

    // A failing dispatch retries in place before it gives up, so wait for
    // each one to record its failure rather than reading straight away.
    let errors = 0;
    for (let i = 0; i < 3; i++) {
      await object.makeWakeDue();
      await runDurableObjectAlarm(object);
      for (let poll = 0; poll < 400; poll++) {
        if (((await object.wakeState())?.errors ?? 0) > errors) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const delay = ((await object.wakeJobTime()) ?? 0) - Date.now();
      const state = await object.wakeState();
      expect(state?.errors).toBe(errors + 1);
      errors = state!.errors!;
      expect(delay).toBeGreaterThan(backoff(errors - 1) - 500);
      expect(delay).toBeLessThanOrEqual(backoff(errors - 1) + 100);
    }
  });
});
