import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkpointWakeAt, type PiTask } from "../index";

function task(checkpoint: unknown): PiTask {
  return {
    id: 1,
    kind: "app.any",
    session: "1",
    background: true,
    input: null,
    checkpoint
  };
}

function stub(name: string) {
  return env.PI_DEADLINE_TEST.getByName(name);
}

describe("PiHarness wake helpers", () => {
  it("checkpointWakeAt reads a numeric wakeAt from the checkpoint", () => {
    expect(checkpointWakeAt(task({ phase: "wait", wakeAt: 1_000 }))).toEqual(
      new Date(1_000)
    );
    expect(checkpointWakeAt(task({ phase: "wait" }))).toBeUndefined();
    expect(
      checkpointWakeAt(task({ phase: "wait", wakeAt: "soon" }))
    ).toBeUndefined();
    expect(checkpointWakeAt(task(undefined))).toBeUndefined();
  });

  it("parks the wake at the time a sleepUntil task committed", async () => {
    const name = crypto.randomUUID();
    const runAt = Date.now() + 60_000;
    await stub(name).helperSleep(runAt);
    // Wait until the task has committed its wakeAt, then crash.
    let committed = false;
    for (let i = 0; i < 100 && !committed; i++) {
      committed = (await stub(name).checkpoints()).some((checkpoint) =>
        checkpoint.includes(`"wakeAt":${runAt}`)
      );
      if (!committed) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(committed).toBe(true);

    await abortAllDurableObjects();
    const object = stub(name);
    await object.start();
    await object.makeWakeDue();
    await runDurableObjectAlarm(object);
    expect(await object.wakeJobTime()).toBe(runAt);
  });

  it("finishes a sleepUntil task once its time comes", async () => {
    const object = stub(crypto.randomUUID());
    await object.helperSleep(Date.now() + 200);
    for (let i = 0; i < 100; i++) {
      if ((await object.liveTasks()) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await object.liveTasks()).toBe(0);
  });
});
