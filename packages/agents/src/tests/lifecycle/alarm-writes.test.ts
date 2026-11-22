import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  Lifecycle,
  LifecycleCapability,
  type LifecycleJobPushOptions
} from "../../lifecycle";

class Jobs extends LifecycleCapability {
  constructor() {
    super("alarm-writes-probe");
  }

  onJob(): void {}

  push(options: LifecycleJobPushOptions) {
    return this.lifecycle.jobs.push(options);
  }

  cancel(id: string) {
    return this.lifecycle.jobs.cancel(id);
  }
}

/** Bind native methods so the wrappers below can call them. */
function bound<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(object, key) {
      if (key in overrides) return overrides[key as keyof T];
      const value = Reflect.get(object, key, object);
      return typeof value === "function" ? value.bind(object) : value;
    }
  });
}

/**
 * Each `setAlarm()` and `deleteAlarm()` is billed as a row written. Count
 * them through a storage wrapper around the real storage.
 */
function countingAlarmWrites(state: DurableObjectState) {
  const writes: string[] = [];
  const storage = bound(state.storage, {
    setAlarm: (time: number | Date) => {
      writes.push(`set:${Number(time)}`);
      return state.storage.setAlarm(time);
    },
    deleteAlarm: () => {
      writes.push("delete");
      return state.storage.deleteAlarm();
    }
  });
  const ctx = bound(state, { storage });
  return { writes, ctx };
}

describe("Lifecycle alarm writes", () => {
  it("writes the alarm only when its time changes", async () => {
    const stub = env.CapabilityHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance, state) => {
      const { writes, ctx } = countingAlarmWrites(state);
      const host = Object.create(instance, { ctx: { value: ctx } });
      const jobs = new Jobs();
      const lifecycle = new Lifecycle(host).use(jobs);
      await lifecycle.start();

      const first = Date.now() + 60_000;
      await jobs.push({ id: "a", fn: "tick", time: first });
      // Later jobs leave the earliest wake where it is.
      await jobs.push({ id: "b", fn: "tick", time: first + 1_000 });
      await jobs.push({ id: "c", fn: "tick", time: first + 2_000 });
      await jobs.cancel("c");
      await lifecycle.rearmAlarm();

      expect(writes).toEqual([`set:${first}`]);
      expect(await state.storage.getAlarm()).toBe(first);

      // Emptying the queue deletes the alarm once.
      await jobs.cancel("a");
      await jobs.cancel("b");
      await lifecycle.rearmAlarm();
      expect(writes).toEqual([
        `set:${first}`,
        `set:${first + 1_000}`,
        "delete"
      ]);
    });
  });
});
