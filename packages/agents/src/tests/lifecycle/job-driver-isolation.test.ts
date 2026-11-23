import { describe, expect, it } from "vitest";
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobPushOptions
} from "../../lifecycle";
import { Queue } from "../../queue";
import { withCapabilityHarness } from "../shared/capability-harness";

/** An error the platform marks retryable, as a failing downstream stub does. */
function retryableError(): Error {
  return Object.assign(new Error("downstream object is restarting"), {
    retryable: true
  });
}

/** Runs `fn` as a job; `poison` jobs always fail with a platform-class error. */
class Jobs extends LifecycleCapability {
  constructor(
    id: string,
    readonly ran: string[]
  ) {
    super(id);
  }

  onJob({ job }: LifecycleJobContext): void {
    this.ran.push(job.id);
    if (job.fn === "poison") throw retryableError();
  }

  push(options: LifecycleJobPushOptions) {
    return this.lifecycle.jobs.push(options);
  }

  get(id: string) {
    return this.lifecycle.jobs.get(id);
  }
}

const QUICK = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 };

describe("job driver isolation", () => {
  it("runs other owners' due jobs when one fails with a platform-class error", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const ran: string[] = [];
      const failing = new Jobs("isolation-failing", ran);
      const other = new Jobs("isolation-other", ran);
      const { lifecycle } = install(failing);
      lifecycle.use(other);
      await lifecycle.start();
      const now = Date.now();
      await failing.push({
        id: "poison",
        fn: "poison",
        time: now - 2_000,
        retry: QUICK
      });
      await other.push({ id: "next", fn: "ok", time: now - 1_000 });

      // The alarm still fails, so the platform sees the failure, but only
      // after the other owner's job had its turn.
      await expect(lifecycle.alarm()).rejects.toThrow("restarting");

      expect(ran).toEqual(["poison", "next"]);
      expect(other.get("next")).toBeUndefined();
    });
  });

  it("holds back the failing owner's later jobs, in order, for the deferral", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const ran: string[] = [];
      const jobs = new Jobs("isolation-failing", ran);
      const { lifecycle } = install(jobs);
      await lifecycle.start();
      const now = Date.now();
      await jobs.push({
        id: "first",
        fn: "poison",
        time: now - 2_000,
        retry: QUICK
      });
      await jobs.push({ id: "second", fn: "ok", time: now - 1_000 });

      await expect(lifecycle.alarm()).rejects.toThrow("restarting");

      // The owner's order holds: the job behind the failing one waits, and
      // both keep their times.
      expect(ran).toEqual(["first"]);
      expect(jobs.get("first")?.time).toBe(now - 2_000);
      expect(jobs.get("second")?.time).toBe(now - 1_000);
      // The next wake is the deferral's end, not an immediate re-fire.
      const alarm = await storage.getAlarm();
      expect(alarm).toBeGreaterThanOrEqual(now + 25_000);
    });
  });

  it("keeps a Queue's order when its head item is deferred", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const calls: string[] = [];
      let failNext = true;
      const queue = new Queue({
        callbacks: {
          create: () => {
            calls.push("create");
            if (failNext) {
              failNext = false;
              throw retryableError();
            }
          },
          update: () => void calls.push("update")
        },
        retry: QUICK
      });
      const { lifecycle } = install(queue);
      await lifecycle.start();
      await queue.push("create", null);
      await queue.push("update", null);

      await expect(lifecycle.alarm()).rejects.toThrow("restarting");
      expect(calls).toEqual(["create"]);
      expect((await queue.list()).map((item) => item.callback)).toEqual([
        "create",
        "update"
      ]);

      // Inside the hold an early alarm runs nothing of this Queue.
      await lifecycle.alarm();
      expect(calls).toEqual(["create"]);

      // After the hold (here: a fresh isolate, which forgets it) the head
      // item runs first again, then the one behind it.
      const later = new Queue({
        callbacks: {
          create: () => void calls.push("create"),
          update: () => void calls.push("update")
        },
        retry: QUICK
      });
      const fresh = install(later).lifecycle;
      await fresh.start();
      await fresh.alarm();
      expect(calls).toEqual(["create", "create", "update"]);
    });
  });
});

describe("job driver deferral", () => {
  it("keeps holding the failing owner when another owner's alarm comes first", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const ran: string[] = [];
      const failing = new Jobs("isolation-failing", ran);
      const other = new Jobs("isolation-other", ran);
      const { lifecycle } = install(failing);
      lifecycle.use(other);
      await lifecycle.start();
      const now = Date.now();
      await failing.push({
        id: "poison",
        fn: "poison",
        time: now - 2_000,
        retry: QUICK
      });

      await expect(lifecycle.alarm()).rejects.toThrow("restarting");
      // Another owner's job becomes due inside the hold.
      await other.push({ id: "later", fn: "ok", time: Date.now() - 1 });
      await lifecycle.alarm();

      expect(ran).toEqual(["poison", "later"]);
    });
  });
});

describe("job driver hold within one scan", () => {
  it("keeps skipping a held owner when its hold ends during the scan", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const ran: string[] = [];
      const queued = new Jobs("isolation-failing", ran);
      const slow = new Jobs("isolation-other", ran);
      const { lifecycle } = install(queued);
      lifecycle.use(slow);
      await lifecycle.start();
      const now = Date.now();
      await queued.push({
        id: "head",
        fn: "poison",
        time: now - 3_000,
        retry: QUICK
      });
      await lifecycle.alarm().catch(() => {});
      expect(ran).toEqual(["head"]);

      // Inside the hold: another owner's job runs first, and its callback
      // outlasts the hold.
      await queued.push({ id: "behind", fn: "ok", time: now - 1_000 });
      await slow.push({ id: "slow", fn: "ok", time: now - 2_000 });
      const realNow = Date.now;
      slow.onJob = ({ job }: LifecycleJobContext) => {
        ran.push(job.id);
        const later = realNow() + 31_000;
        Date.now = () => later;
      };
      try {
        await lifecycle.alarm();
      } finally {
        Date.now = realNow;
      }

      // The job behind the held head did not run ahead of it.
      expect(ran).toEqual(["head", "slow"]);
    });
  });

  it("does not wake early for a held owner when another job is pushed", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const ran: string[] = [];
      const failing = new Jobs("isolation-failing", ran);
      const other = new Jobs("isolation-other", ran);
      const { lifecycle } = install(failing);
      lifecycle.use(other);
      await lifecycle.start();
      const now = Date.now();
      await failing.push({
        id: "poison",
        fn: "poison",
        time: now - 1_000,
        retry: QUICK
      });
      await lifecycle.alarm().catch(() => {});

      await other.push({ id: "later", fn: "ok", time: now + 60_000 });

      // The held job is overdue, but the wake waits for the hold's end.
      expect(await storage.getAlarm()).toBeGreaterThanOrEqual(now + 25_000);
    });
  });
});

describe("job driver hold and the alarm", () => {
  async function heldFailingOwner(
    install: Parameters<
      Parameters<typeof withCapabilityHarness>[0]
    >[0]["install"]
  ) {
    const ran: string[] = [];
    const failing = new Jobs("isolation-failing", ran);
    const other = new Jobs("isolation-other", ran);
    const { lifecycle } = install(failing);
    lifecycle.use(other);
    await lifecycle.start();
    await failing.push({
      id: "poison",
      fn: "poison",
      time: Date.now() - 1_000,
      retry: QUICK
    });
    await lifecycle.alarm().catch(() => {});
    return { failing, other, lifecycle };
  }

  it("lets an exclusive job keep its own wake during a hold", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { other } = await heldFailingOwner(install);
      const teardown = Date.now() + 60_000;
      await other.push({
        id: "teardown",
        fn: "ok",
        time: teardown,
        exclusive: true
      });
      expect(await storage.getAlarm()).toBe(teardown);
    });
  });

  it("keeps a held owner's exclusive job exclusive", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { failing, other } = await heldFailingOwner(install);
      const now = Date.now();
      // The held owner's job becomes exclusive, due soon; another owner
      // has an ordinary job after the hold ends and a later exclusive one.
      await failing.push({
        id: "poison",
        fn: "poison",
        time: now + 1_000,
        exclusive: true
      });
      await other.push({ id: "ordinary", fn: "ok", time: now + 45_000 });
      await other.push({
        id: "later-exclusive",
        fn: "ok",
        time: now + 90_000,
        exclusive: true
      });
      // The held exclusive job wakes at the hold's end, ahead of the later
      // exclusive one, and the ordinary job does not get its own wake.
      const alarm = await storage.getAlarm();
      expect(alarm).toBeGreaterThanOrEqual(now + 25_000);
      expect(alarm).toBeLessThan(now + 45_000);
    });
  });

  it("drops the hold's wake once the held owner has no jobs", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const { lifecycle } = await heldFailingOwner(install);
      storage.sql.exec("DELETE FROM cf_agents_jobs WHERE id = 'poison'");
      await lifecycle.rearmAlarm();
      expect(await storage.getAlarm()).toBeNull();
    });
  });
});

describe("job driver staggered holds", () => {
  it("wakes for each held owner at its own hold's end, and lets an earlier ordinary job win", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const ran: string[] = [];
      const a = new Jobs("hold-a", ran);
      const b = new Jobs("hold-b", ran);
      const other = new Jobs("hold-other", ran);
      const { lifecycle } = install(a);
      lifecycle.use(b);
      lifecycle.use(other);
      await lifecycle.start();
      await a.push({
        id: "a",
        fn: "poison",
        time: Date.now() - 2,
        retry: QUICK
      });
      await lifecycle.alarm().catch(() => {});
      // b is held later than a.
      await b.push({
        id: "b",
        fn: "poison",
        time: Date.now() - 1,
        retry: QUICK
      });
      await lifecycle.alarm().catch(() => {});
      // a's job goes; only b's held job and an ordinary job remain.
      storage.sql.exec("DELETE FROM cf_agents_jobs WHERE id = 'a'");
      const now = Date.now();
      await other.push({ id: "soon", fn: "ok", time: now + 5_000 });
      // The ordinary job is earlier than any hold's end: it is the wake.
      expect(await storage.getAlarm()).toBe(now + 5_000);
      storage.sql.exec("DELETE FROM cf_agents_jobs WHERE id = 'soon'");
      await lifecycle.rearmAlarm();
      // Without it, the wake is b's own hold's end, not a's earlier one.
      const alarm = await storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeGreaterThanOrEqual(now + 25_000);
    });
  });
});
