/**
 * Counts instances that survive garbage collection, for tests that prove an
 * evicted Durable Object's memory is released. Worker-safe: fixtures run
 * this inside the object, where the instances live.
 */
export class LiveInstances {
  readonly #instances: {
    readonly key: string;
    readonly ref: WeakRef<object>;
  }[] = [];

  /** Track `instance` under `key`, usually the object's name. */
  track(key: string, instance: object): void {
    this.#instances.push({ key, ref: new WeakRef(instance) });
  }

  /**
   * Count the instances tracked under `key` still alive after forcing full
   * GCs. Needs V8's `--expose-gc`, which the test project passes to workerd.
   * An evicted object is released once the runtime tears it down, so this
   * gives teardown a few turns before settling on a count above one.
   */
  async countAfterGC(key: string): Promise<number> {
    const { gc } = globalThis as { gc?: () => void };
    if (typeof gc !== "function") {
      throw new Error("LiveInstances.countAfterGC() needs V8's --expose-gc");
    }
    let live = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 10 && live > 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      gc();
      live = this.#instances.filter(
        (instance) => instance.key === key && instance.ref.deref() !== undefined
      ).length;
    }
    return live;
  }
}
