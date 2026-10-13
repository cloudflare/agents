import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function stub(name: string) {
  return env.PI_QUARANTINE_TEST.getByName(name);
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean
): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const attempt = await read().then(
      (value) => ({ value }),
      () => undefined
    );
    if (attempt !== undefined && done(attempt.value)) return attempt.value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condition was never met");
}

const MEMORY_LIMIT_RESET =
  "Durable Object's isolate exceeded its memory limit and was reset.";

describe("PiHarness resource quarantine", () => {
  it("aborts a session's work once the alarm breaker seals on it, and leaves other sessions running", async () => {
    const name = crypto.randomUUID();
    let object = stub(name);
    // The root's foreground work is what keeps exceeding memory.
    await object.sleepUntil(Date.now() + 60_000, { background: false });
    const other = await object.createSession();
    await object.sleepUntil(Date.now() + 60_000, { session: other });
    await object.failIdleWait(MEMORY_LIMIT_RESET);

    await abortAllDurableObjects();
    object = stub(name);
    await object.start();
    // This object seals at the first strike, then resets its isolate.
    await runDurableObjectAlarm(object).catch(() => false);

    // A later start must not resume the work that sealed the breaker.
    expect(
      await eventually(
        async () => {
          const fresh = stub(name);
          await fresh.start();
          return fresh.liveTasks("1");
        },
        (live) => live === 0
      )
    ).toBe(0);
    object = stub(name);
    // Startup may give the session a wake while its abort handlers finish;
    // that wake completes once the session has no live work.
    await eventually(
      async () => {
        await runDurableObjectAlarm(object);
        return object.wakeJobTime("1");
      },
      (time) => time === null
    );
    expect(await object.liveTasks(other)).toBe(1);
    expect(await object.wakeJobTime(other)).not.toBeNull();
  });
});
