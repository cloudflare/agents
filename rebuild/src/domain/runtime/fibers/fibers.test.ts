import { describe, expect, it, vi } from "vitest";
import { createMemoryAlarmTimer } from "../../../adapters/memory/alarms.js";
import { createTestClock, type TestClock } from "../../../adapters/memory/clock.js";
import { createMemoryKeyValueStore } from "../../../adapters/memory/store.js";
import { createEventBus, type ObservabilityEvent } from "../../../kernel/events.js";
import type { IdSource } from "../../../kernel/ids.js";
import type { KeyValueStore } from "../../../ports/storage.js";
import { createKeepAlive, type KeepAlive } from "../scheduling/keep-alive.js";
import { createScheduler, type Scheduler } from "../scheduling/scheduler.js";
import {
  createFiberService,
  RECOVERY_SCHEDULE_ID,
  type FiberRecoveryContext,
  type FiberRecoveryResult,
  type FiberService,
} from "./fibers.js";

function counterIds(): IdSource {
  let n = 0;
  return {
    newId(prefix: string) {
      n += 1;
      return `${prefix}_${n}`;
    },
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type OnRecovered = (ctx: FiberRecoveryContext) => Promise<void | FiberRecoveryResult>;

interface Harness {
  store: KeyValueStore;
  clock: TestClock;
  scheduler: Scheduler;
  keepAlive: KeepAlive;
  events: ObservabilityEvent[];
  onRecovered: ReturnType<typeof vi.fn>;
  service: FiberService;
  /** Simulates an eviction: a fresh service instance over the same store (empty live set). */
  makeService(opts?: { onRecovered?: OnRecovered; recoveryMaxAgeMs?: number }): FiberService;
}

function harness(opts?: { onRecovered?: OnRecovered; recoveryMaxAgeMs?: number }): Harness {
  const store = createMemoryKeyValueStore();
  const clock = createTestClock(0);
  const alarm = createMemoryAlarmTimer(clock);
  const events: ObservabilityEvent[] = [];
  const bus = createEventBus({ agent: "test", name: "agent-1" }, () => clock.now());
  bus.subscribe("*", (e) => events.push(e));
  const ids = counterIds();

  const serviceRef: { current: FiberService | null } = { current: null };
  const scheduler = createScheduler({
    store,
    alarm,
    clock,
    ids,
    bus,
    dispatch: async (callback) => {
      if (callback === RECOVERY_SCHEDULE_ID) await serviceRef.current?.checkInterrupted();
    },
  });
  alarm.onAlarm(() => scheduler.onAlarm());
  const keepAlive = createKeepAlive(scheduler);

  const onRecovered = vi.fn(async (_ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> => undefined);

  function makeService(o?: { onRecovered?: OnRecovered; recoveryMaxAgeMs?: number }): FiberService {
    const svc = createFiberService({
      store,
      clock,
      ids,
      bus,
      keepAlive,
      scheduler,
      onRecovered: o?.onRecovered ?? onRecovered,
      ...(o?.recoveryMaxAgeMs !== undefined ? { recoveryMaxAgeMs: o.recoveryMaxAgeMs } : {}),
    });
    serviceRef.current = svc;
    return svc;
  }

  const service = makeService(opts);
  return { store, clock, scheduler, keepAlive, events, onRecovered, service, makeService };
}

interface RawRunRow {
  id: string;
  name: string;
  snapshot: unknown;
}

function runRow(store: KeyValueStore, fiberId: string): RawRunRow | undefined {
  return store.get<RawRunRow>(`fiber:run:${fiberId}`);
}

describe("createFiberService", () => {
  describe("run (plain fibers)", () => {
    it("returns the closure's value", async () => {
      const { service } = harness();
      const result = await service.run("job", async () => 42);
      expect(result).toBe(42);
    });

    it("inserts the run row before the closure executes and deletes it after completion", async () => {
      const { service, store } = harness();
      let rowDuring: RawRunRow | undefined;
      let id = "";
      await service.run("job", async (ctx) => {
        id = ctx.id;
        rowDuring = runRow(store, ctx.id);
      });
      expect(rowDuring).toBeDefined();
      expect(rowDuring!.name).toBe("job");
      expect(runRow(store, id)).toBeUndefined();
    });

    it("deletes the run row and rethrows when the closure throws", async () => {
      const { service, store } = harness();
      let id = "";
      await expect(
        service.run("job", async (ctx) => {
          id = ctx.id;
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(runRow(store, id)).toBeUndefined();
    });

    it("holds a keep-alive ref for the duration of the run", async () => {
      const { service, keepAlive } = harness();
      let refsDuring = -1;
      await service.run("job", async () => {
        refsDuring = keepAlive.activeRefs();
      });
      expect(refsDuring).toBe(1);
      expect(keepAlive.activeRefs()).toBe(0);
    });

    it("releases the keep-alive ref when the closure throws", async () => {
      const { service, keepAlive } = harness();
      await expect(
        service.run("job", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(keepAlive.activeRefs()).toBe(0);
    });

    it("emits fiber:run:started and fiber:run:completed with elapsedMs", async () => {
      const { service, events, clock } = harness();
      await service.run("job", async () => {
        clock.advance(500);
      });
      const started = events.filter((e) => e.type === "fiber:run:started");
      expect(started).toHaveLength(1);
      expect(started[0]!.payload).toMatchObject({ fiberId: "fiber_1", fiberName: "job", managed: false });
      const completed = events.filter((e) => e.type === "fiber:run:completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]!.payload).toMatchObject({ fiberId: "fiber_1", fiberName: "job", elapsedMs: 500 });
    });

    it("emits fiber:run:failed with a structured error when the closure throws", async () => {
      const { service, events } = harness();
      await expect(
        service.run("job", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const failed = events.filter((e) => e.type === "fiber:run:failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.payload).toMatchObject({
        fiberId: "fiber_1",
        fiberName: "job",
        error: { name: "Error", message: "boom" },
      });
    });
  });

  describe("stash", () => {
    it("ctx.stash persists the snapshot synchronously to the run row", async () => {
      const { service, store } = harness();
      await service.run("job", async (ctx) => {
        ctx.stash({ step: 1 });
        expect(runRow(store, ctx.id)!.snapshot).toEqual({ step: 1 });
      });
    });

    it("stash fully replaces the previous snapshot", async () => {
      const { service, store } = harness();
      await service.run("job", async (ctx) => {
        ctx.stash({ step: 1, extra: true });
        ctx.stash({ step: 2 });
        expect(runRow(store, ctx.id)!.snapshot).toEqual({ step: 2 });
        expect(ctx.snapshot).toEqual({ step: 2 });
      });
    });

    it("ambient service.stash writes to the current fiber", async () => {
      const { service, store } = harness();
      await service.run("job", async (ctx) => {
        service.stash({ ambient: true });
        expect(runRow(store, ctx.id)!.snapshot).toEqual({ ambient: true });
      });
    });

    it("ambient stash throws outside a fiber", () => {
      const { service } = harness();
      expect(() => service.stash({ x: 1 })).toThrow();
    });

    it("concurrent fibers ambient-stash into their own rows", async () => {
      const { service, store } = harness();
      const gateA = deferred();
      const gateB = deferred();

      const pA = service.run("a", async (ctx) => {
        await gateA.promise;
        service.stash({ who: "a" });
        return runRow(store, ctx.id)!.snapshot;
      });
      const pB = service.run("b", async (ctx) => {
        await gateB.promise;
        service.stash({ who: "b" });
        return runRow(store, ctx.id)!.snapshot;
      });

      // Interleave: b finishes first, then a.
      gateB.resolve();
      gateA.resolve();
      const [snapA, snapB] = await Promise.all([pA, pB]);
      expect(snapA).toEqual({ who: "a" });
      expect(snapB).toEqual({ who: "b" });
    });
  });

  describe("start (managed fibers)", () => {
    it("settles the ledger completed and reports it when waitForCompletion", async () => {
      const { service, store } = harness();
      const result = await service.start("job", async () => {}, { waitForCompletion: true });
      expect(result).toEqual({ fiberId: "fiber_1", accepted: true, status: "completed" });
      expect(service.inspect("fiber_1")).toMatchObject({ fiberId: "fiber_1", name: "job", status: "completed" });
      expect(runRow(store, "fiber_1")).toBeUndefined();
    });

    it("fire-and-forget returns running immediately and settles in the background", async () => {
      const { service } = harness();
      const gate = deferred();
      const result = await service.start("job", async () => {
        await gate.promise;
      });
      expect(result).toEqual({ fiberId: "fiber_1", accepted: true, status: "running" });
      expect(service.inspect("fiber_1")!.status).toBe("running");
      gate.resolve();
      await vi.waitFor(() => expect(service.inspect("fiber_1")!.status).toBe("completed"));
    });

    it("the ledger row is visible with status running while the closure executes", async () => {
      const { service } = harness();
      let statusDuring = "";
      await service.start(
        "job",
        async (ctx) => {
          statusDuring = service.inspect(ctx.id)!.status;
        },
        { waitForCompletion: true },
      );
      expect(statusDuring).toBe("running");
    });

    it("a closure throw settles the ledger error with the message (no retries)", async () => {
      const { service, events } = harness();
      const fn = vi.fn(async () => {
        throw new Error("kaput");
      });
      const result = await service.start("job", fn, { waitForCompletion: true });
      expect(result).toEqual({ fiberId: "fiber_1", accepted: true, status: "error", error: "kaput" });
      expect(fn).toHaveBeenCalledTimes(1);
      const inspection = service.inspect("fiber_1")!;
      expect(inspection.status).toBe("error");
      expect(inspection.error).toBe("kaput");
      expect(events.some((e) => e.type === "fiber:run:failed")).toBe(true);
    });

    it("duplicate start with the same idempotency key returns the retained status without re-running", async () => {
      const { service } = harness();
      const first = await service.start("job", async () => {}, {
        idempotencyKey: "k1",
        waitForCompletion: true,
      });
      const dupFn = vi.fn(async () => {});
      const second = await service.start("job", dupFn, { idempotencyKey: "k1" });
      expect(second).toEqual({ fiberId: first.fiberId, accepted: false, status: "completed" });
      expect(dupFn).not.toHaveBeenCalled();
    });

    it("a concurrent duplicate with waitForCompletion joins the in-flight run", async () => {
      const { service } = harness();
      const gate = deferred();
      const fn = vi.fn(async () => {
        await gate.promise;
      });
      const firstPromise = service.start("job", fn, { idempotencyKey: "k1", waitForCompletion: true });
      const dupFn = vi.fn(async () => {});
      const secondPromise = service.start("job", dupFn, { idempotencyKey: "k1", waitForCompletion: true });

      gate.resolve();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first).toMatchObject({ accepted: true, status: "completed" });
      expect(second).toMatchObject({ fiberId: first.fiberId, accepted: false, status: "completed" });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(dupFn).not.toHaveBeenCalled();
    });

    it("a concurrent duplicate without waitForCompletion reports the in-flight running status", async () => {
      const { service } = harness();
      const gate = deferred();
      void service.start("job", async () => gate.promise, { idempotencyKey: "k1" });
      const second = await service.start("job", async () => {}, { idempotencyKey: "k1" });
      expect(second).toMatchObject({ fiberId: "fiber_1", accepted: false, status: "running" });
      gate.resolve();
    });

    it("persists metadata and is findable via inspectByKey", async () => {
      const { service } = harness();
      await service.start("job", async () => {}, {
        idempotencyKey: "hook-42",
        metadata: { source: "webhook" },
        waitForCompletion: true,
      });
      const found = service.inspectByKey("hook-42");
      expect(found).toMatchObject({
        fiberId: "fiber_1",
        name: "job",
        status: "completed",
        idempotencyKey: "hook-42",
        metadata: { source: "webhook" },
      });
      expect(service.inspectByKey("nope")).toBeNull();
    });
  });

  describe("cancel", () => {
    it("aborts the fiber's signal and settles the ledger aborted", async () => {
      const { service } = harness();
      let sawAbort = false;
      const resultPromise = service.start(
        "job",
        async (ctx) => {
          await new Promise<void>((_, reject) => {
            ctx.signal.addEventListener("abort", () => {
              sawAbort = true;
              reject(new Error("aborted"));
            });
          });
        },
        { waitForCompletion: true },
      );

      expect(service.cancel("fiber_1", "user asked")).toBe(true);
      const result = await resultPromise;
      expect(sawAbort).toBe(true);
      expect(result).toMatchObject({ fiberId: "fiber_1", accepted: true, status: "aborted", error: "user asked" });
      expect(service.inspect("fiber_1")!.status).toBe("aborted");
    });

    it("waitForCompletion resolves on cancel even when the closure never finishes", async () => {
      const { service } = harness();
      const resultPromise = service.start(
        "job",
        async () => {
          await new Promise(() => {}); // non-cooperative: ignores the signal forever
        },
        { waitForCompletion: true },
      );
      expect(service.cancel("fiber_1")).toBe(true);
      const result = await resultPromise;
      expect(result).toMatchObject({ fiberId: "fiber_1", status: "aborted" });
    });

    it("returns false for an unknown fiber", () => {
      const { service } = harness();
      expect(service.cancel("nope")).toBe(false);
    });

    it("cancelByKey cancels via the idempotency key", async () => {
      const { service } = harness();
      void service.start("job", async () => new Promise(() => {}), { idempotencyKey: "k1" });
      expect(service.cancelByKey("k1", "bye")).toBe(true);
      expect(service.inspect("fiber_1")!.status).toBe("aborted");
      expect(service.cancelByKey("missing")).toBe(false);
    });
  });

  describe("inspect / list", () => {
    it("inspect returns null for an unknown id", () => {
      const { service } = harness();
      expect(service.inspect("nope")).toBeNull();
    });

    it("list returns managed rows and running plain fibers, filterable by status and name", async () => {
      const { service } = harness();
      await service.start("done-job", async () => {}, { waitForCompletion: true }); // fiber_1 completed
      await service.start(
        "bad-job",
        async () => {
          throw new Error("x");
        },
        { waitForCompletion: true },
      ); // fiber_2 error
      void service.run("plain-job", async () => new Promise(() => {})); // fiber_3 running plain

      const all = service.list();
      expect(all.map((f) => f.fiberId).sort()).toEqual(["fiber_1", "fiber_2", "fiber_3"]);

      const completed = service.list({ status: ["completed"] });
      expect(completed).toHaveLength(1);
      expect(completed[0]!.fiberId).toBe("fiber_1");

      const running = service.list({ status: ["running"] });
      expect(running).toHaveLength(1);
      expect(running[0]!.name).toBe("plain-job");

      const byName = service.list({ name: "bad-job" });
      expect(byName).toHaveLength(1);
      expect(byName[0]!.status).toBe("error");
    });
  });

  describe("recovery: checkInterrupted", () => {
    async function orphanedManaged(h: Harness): Promise<void> {
      // First instance starts a managed fiber that stashes then hangs forever.
      void h.service.start(
        "webhook-job",
        async (ctx) => {
          ctx.stash({ step: 2 });
          await new Promise(() => {});
        },
        { idempotencyKey: "k1", metadata: { m: 1 } },
      );
      await Promise.resolve(); // let the closure reach its first await (it stashes synchronously anyway)
    }

    it("marks orphaned managed rows interrupted and calls onRecovered with the snapshot", async () => {
      const h = harness();
      await orphanedManaged(h);

      let statusInsideHook: string | undefined;
      const hook = vi.fn(async (ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> => {
        statusInsideHook = service2.inspect(ctx.fiberId)!.status;
        return undefined;
      });
      const service2 = h.makeService({ onRecovered: hook });
      await service2.checkInterrupted();

      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook.mock.calls[0]![0]).toMatchObject({
        fiberId: "fiber_1",
        name: "webhook-job",
        snapshot: { step: 2 },
        metadata: { m: 1 },
        idempotencyKey: "k1",
        createdAt: 0,
        recoveryReason: "interrupted",
      });
      // Ledger was marked interrupted before the hook ran.
      expect(statusInsideHook).toBe("interrupted");
      expect(h.events.some((e) => e.type === "fiber:run:interrupted" && e.payload.fiberId === "fiber_1")).toBe(true);
      expect(h.events.some((e) => e.type === "fiber:recovery:detected" && e.payload.fiberId === "fiber_1")).toBe(true);
      expect(h.events.some((e) => e.type === "fiber:recovery:attempt")).toBe(true);
    });

    it("a hook result settles the managed row and deletes the run row", async () => {
      const h = harness();
      await orphanedManaged(h);
      const service2 = h.makeService({
        onRecovered: async () => ({ status: "completed" as const, snapshot: { done: true } }),
      });
      await service2.checkInterrupted();

      const inspection = service2.inspect("fiber_1")!;
      expect(inspection.status).toBe("completed");
      expect(inspection.snapshot).toEqual({ done: true });
      expect(runRow(h.store, "fiber_1")).toBeUndefined();
      expect(h.events.some((e) => e.type === "fiber:recovery:handled")).toBe(true);
      // A second scan finds nothing to do.
      const before = h.events.length;
      await service2.checkInterrupted();
      expect(h.events.slice(before).filter((e) => e.type.startsWith("fiber:recovery"))).toHaveLength(0);
    });

    it("a hook returning undefined leaves the managed row interrupted", async () => {
      const h = harness();
      await orphanedManaged(h);
      const service2 = h.makeService({ onRecovered: async () => undefined });
      await service2.checkInterrupted();
      expect(service2.inspect("fiber_1")!.status).toBe("interrupted");
      expect(runRow(h.store, "fiber_1")).toBeUndefined();
    });

    it("plain fiber orphan rows are deleted after the hook returns", async () => {
      const h = harness();
      void h.service.run("plain-job", async (ctx) => {
        ctx.stash({ p: 1 });
        await new Promise(() => {});
      });
      const hook = vi.fn(async (_ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> => undefined);
      const service2 = h.makeService({ onRecovered: hook });
      await service2.checkInterrupted();

      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook.mock.calls[0]![0]).toMatchObject({
        fiberId: "fiber_1",
        name: "plain-job",
        snapshot: { p: 1 },
        recoveryReason: "interrupted",
      });
      expect(runRow(h.store, "fiber_1")).toBeUndefined();
      expect(service2.inspect("fiber_1")).toBeNull(); // plain: no ledger row
    });

    it("live executions in this process are not treated as orphans", async () => {
      const h = harness();
      void h.service.start("job", async () => new Promise(() => {}));
      await h.service.checkInterrupted();
      expect(h.onRecovered).not.toHaveBeenCalled();
      expect(h.service.inspect("fiber_1")!.status).toBe("running");
    });

    it("a throwing hook keeps the row and retries via a scheduler backoff", async () => {
      const h = harness();
      await orphanedManaged(h);

      let calls = 0;
      const hook = vi.fn(async (): Promise<void | FiberRecoveryResult> => {
        calls += 1;
        if (calls === 1) throw new Error("host not ready");
        return { status: "completed" as const };
      });
      const service2 = h.makeService({ onRecovered: hook });
      await service2.checkInterrupted();

      expect(runRow(h.store, "fiber_1")).toBeDefined();
      expect(h.events.some((e) => e.type === "fiber:recovery:failed")).toBe(true);
      const retry = h.scheduler.get(RECOVERY_SCHEDULE_ID);
      expect(retry).toBeDefined();
      expect(retry!.nextRunAt).toBe(h.clock.now() + 1000);

      h.clock.advance(1000);
      await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(service2.inspect("fiber_1")!.status).toBe("completed"));
      expect(runRow(h.store, "fiber_1")).toBeUndefined();
      // Once nothing is pending, the retry schedule is dropped.
      expect(h.scheduler.get(RECOVERY_SCHEDULE_ID)).toBeUndefined();
    });

    it("backoff doubles per attempt and caps at 5 minutes", async () => {
      const h = harness();
      await orphanedManaged(h);
      const service2 = h.makeService({
        onRecovered: async () => {
          throw new Error("still broken");
        },
      });

      await service2.checkInterrupted();
      expect(h.scheduler.get(RECOVERY_SCHEDULE_ID)!.nextRunAt - h.clock.now()).toBe(1000);
      await service2.checkInterrupted();
      expect(h.scheduler.get(RECOVERY_SCHEDULE_ID)!.nextRunAt - h.clock.now()).toBe(2000);
      await service2.checkInterrupted();
      expect(h.scheduler.get(RECOVERY_SCHEDULE_ID)!.nextRunAt - h.clock.now()).toBe(4000);

      for (let i = 0; i < 7; i++) await service2.checkInterrupted();
      expect(h.scheduler.get(RECOVERY_SCHEDULE_ID)!.nextRunAt - h.clock.now()).toBe(300_000);
    });

    it("rows older than recoveryMaxAgeMs are discarded with fiber:recovery:skipped", async () => {
      const h = harness();
      await orphanedManaged(h);
      const hook = vi.fn(async (): Promise<void | FiberRecoveryResult> => undefined);
      const service2 = h.makeService({ onRecovered: hook, recoveryMaxAgeMs: 1000 });

      h.clock.advance(1500);
      await service2.checkInterrupted();

      expect(hook).not.toHaveBeenCalled();
      expect(runRow(h.store, "fiber_1")).toBeUndefined();
      const skipped = h.events.filter((e) => e.type === "fiber:recovery:skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.payload).toMatchObject({ fiberId: "fiber_1", reason: "max_age_exceeded" });
      // The managed ledger stays interrupted for manual resolution.
      expect(service2.inspect("fiber_1")!.status).toBe("interrupted");
    });

    it("recoveryMaxAgeMs: 0 retries forever", async () => {
      const h = harness();
      await orphanedManaged(h);
      const hook = vi.fn(async (): Promise<void | FiberRecoveryResult> => {
        throw new Error("never ready");
      });
      const service2 = h.makeService({ onRecovered: hook, recoveryMaxAgeMs: 0 });

      await service2.checkInterrupted();
      h.clock.advance(100 * 86_400_000); // 100 days later
      await service2.checkInterrupted();

      expect(hook.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(runRow(h.store, "fiber_1")).toBeDefined();
      expect(h.events.filter((e) => e.type === "fiber:recovery:skipped")).toHaveLength(0);
    });
  });

  describe("resolve", () => {
    async function interrupted(h: Harness): Promise<FiberService> {
      void h.service.start("job", async () => new Promise(() => {}), { idempotencyKey: "k1" });
      const service2 = h.makeService({ onRecovered: async () => undefined });
      await service2.checkInterrupted();
      expect(service2.inspect("fiber_1")!.status).toBe("interrupted");
      return service2;
    }

    it("updates only interrupted rows and returns true", async () => {
      const h = harness();
      const service2 = await interrupted(h);
      expect(service2.resolve("fiber_1", { status: "completed", snapshot: { manual: true } })).toBe(true);
      const inspection = service2.inspect("fiber_1")!;
      expect(inspection.status).toBe("completed");
      expect(inspection.snapshot).toEqual({ manual: true });
      expect(inspection.settledAt).toBe(h.clock.now());
    });

    it("returns false for non-interrupted rows and unknown ids", async () => {
      const { service } = harness();
      await service.start("job", async () => {}, { waitForCompletion: true });
      expect(service.resolve("fiber_1", { status: "completed" })).toBe(false); // already completed
      expect(service.resolve("nope", { status: "completed" })).toBe(false);
    });

    it("can settle an interrupted row as error with a message", async () => {
      const h = harness();
      const service2 = await interrupted(h);
      expect(service2.resolve("fiber_1", { status: "error", error: "gave up" })).toBe(true);
      const inspection = service2.inspect("fiber_1")!;
      expect(inspection.status).toBe("error");
      expect(inspection.error).toBe("gave up");
    });
  });

  describe("deleteFibers", () => {
    async function seedStatuses(h: Harness): Promise<FiberService> {
      await h.service.start("done", async () => {}, { waitForCompletion: true }); // fiber_1 completed
      await h.service.start(
        "bad",
        async () => {
          throw new Error("x");
        },
        { waitForCompletion: true },
      ); // fiber_2 error
      void h.service.start("gone", async () => new Promise(() => {})); // fiber_3
      h.service.cancel("fiber_3"); // aborted
      void h.service.start("stuck", async () => new Promise(() => {})); // fiber_4
      const service2 = h.makeService({ onRecovered: async () => undefined });
      await service2.checkInterrupted(); // fiber_4 interrupted
      return service2;
    }

    it("defaults to deleting settled rows and never touches interrupted", async () => {
      const h = harness();
      const service2 = await seedStatuses(h);
      expect(service2.list()).toHaveLength(4);
      const deleted = service2.deleteFibers();
      expect(deleted).toBe(3);
      const remaining = service2.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.status).toBe("interrupted");
    });

    it("deletes interrupted rows only when that status is passed explicitly", async () => {
      const h = harness();
      const service2 = await seedStatuses(h);
      expect(service2.deleteFibers({ status: ["interrupted"] })).toBe(1);
      expect(service2.list({ status: ["interrupted"] })).toHaveLength(0);
    });

    it("respects settledBefore", async () => {
      const h = harness();
      await h.service.start("early", async () => {}, { waitForCompletion: true }); // settled at t=0
      h.clock.advance(1000);
      await h.service.start("late", async () => {}, { waitForCompletion: true }); // settled at t=1000
      expect(h.service.deleteFibers({ settledBefore: 500 })).toBe(1);
      const remaining = h.service.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.name).toBe("late");
    });
  });
});
