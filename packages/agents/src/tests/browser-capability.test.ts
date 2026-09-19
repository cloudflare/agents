import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestBrowserAgent } from "./agents/browser";
import {
  BROWSER_HARNESS_SWEEP_IDLE_MS,
  type BrowserHarnessObject,
  createFakeBrowserBinding
} from "./capabilities/browser";
import { withCapabilityHarness } from "./shared/capability-harness";
import { BROWSER_SWEEP_JOB_ID, BrowserSessions } from "../browser/capability";
import { JobQueue, type LifecycleJob } from "../lifecycle/job-queue";
import { namedBrowserSessionKey } from "../browser/session-core";
import type {
  BrowserSessionStore,
  StoredBrowserSession
} from "../browser/session-manager";

/** The Durable Object storage key the auto-supplied store writes `name` to. */
function durableKey(name: string): string {
  return `browser-session:${namedBrowserSessionKey(name)}`;
}

/** A minimal custom store — enough to prove the capability honors one. */
function createMemoryStore(): BrowserSessionStore & {
  sessions: Map<string, StoredBrowserSession>;
} {
  const sessions = new Map<string, StoredBrowserSession>();
  return {
    sessions,
    async acquireLock() {
      return { release: () => {} };
    },
    async get(key) {
      return sessions.get(key);
    },
    async set(key, session) {
      sessions.set(key, session);
    },
    async delete(key) {
      sessions.delete(key);
    },
    async list(prefix) {
      const result = new Map<string, StoredBrowserSession>();
      for (const [key, session] of sessions) {
        if (key.startsWith(prefix)) result.set(key, session);
      }
      return result;
    }
  };
}

/**
 * Make the sweep due now: backdate its Lifecycle job. The stored session's
 * own timestamps are backdated separately, since idleness and tombstone age
 * are judged from the store, not the job.
 */
function backdateSweepJob(storage: DurableObjectStorage): void {
  storage.sql.exec(
    "UPDATE cf_agents_jobs SET time = ? WHERE id = ? AND capability = 'browser'",
    Date.now() - 1000,
    BROWSER_SWEEP_JOB_ID
  );
}

/** Rewrite the stored entry for `name` with backdated timestamps. */
async function backdateStoredSession(
  storage: DurableObjectStorage,
  name: string,
  patch: Partial<StoredBrowserSession>
): Promise<void> {
  const stored = await storage.get<StoredBrowserSession>(durableKey(name));
  if (!stored) throw new Error(`no stored session named ${name}`);
  await storage.put(durableKey(name), { ...stored, ...patch });
}

describe("BrowserSessions capability", () => {
  it("auto-supplies a Durable Object store over the host's storage", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { browser } = createFakeBrowserBinding();
      const { capability } = install(new BrowserSessions({ browser }));

      const resolved = await capability.resolve();
      expect(resolved.name).toBe("default");
      expect(resolved.restarted).toBe(false);

      const stored = await storage.get<StoredBrowserSession>(
        durableKey("default")
      );
      expect(stored?.sessionId).toBe(resolved.sessionId);
    });
  });

  it("honors a custom store instead of the auto-supplied one", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { browser } = createFakeBrowserBinding();
      const store = createMemoryStore();
      const { capability } = install(new BrowserSessions({ browser, store }));

      const resolved = await capability.resolve("scraper");
      expect(store.sessions.get(namedBrowserSessionKey("scraper"))).toEqual(
        expect.objectContaining({ sessionId: resolved.sessionId })
      );
      expect(await storage.get(durableKey("scraper"))).toBeUndefined();
    });
  });

  it("reapplies durable creation options on every create", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const binding = createFakeBrowserBinding();
      const { capability } = install(
        new BrowserSessions({
          browser: binding.browser,
          create: {
            recording: true,
            guardrails: { allowedDomains: ["example.com", "*.example.com"] }
          }
        })
      );

      const first = await capability.resolve();
      binding.kill(first.sessionId);
      const second = await capability.resolve();
      expect(second.restarted).toBe(true);

      const acquires = binding.requests.filter(
        (request) => request.method === "POST" && !request.upgrade
      );
      expect(acquires).toHaveLength(2);
      for (const acquire of acquires) {
        expect(acquire.url).toContain("recording=true");
        expect(acquire.body).toEqual({
          guardrails: { allowedDomains: ["example.com", "*.example.com"] }
        });
      }
    });
  });

  it("lists named sessions with live/closed status and host-only ids", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { browser } = createFakeBrowserBinding();
      const { capability } = install(new BrowserSessions({ browser }));

      await capability.resolve("checkout");
      await capability.resolve("scraper");
      await capability.close("scraper");

      const views = await capability.sessions();
      expect(views.map(({ name, status }) => ({ name, status }))).toEqual([
        { name: "checkout", status: "live" },
        { name: "scraper", status: "closed" }
      ]);
      for (const view of views) {
        expect(view.sessionId).toMatch(/^session-/);
        expect(view.createdAt).toBeGreaterThan(0);
        expect(view.updatedAt).toBeGreaterThanOrEqual(view.createdAt);
      }
    });
  });

  it("mints Live View URLs fresh on every call, never persisting them", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const binding = createFakeBrowserBinding();
      const { capability } = install(
        new BrowserSessions({ browser: binding.browser })
      );
      const resolved = await capability.resolve("checkout");

      const first = await capability.liveView("checkout");
      expect(first?.sessionId).toBe(resolved.sessionId);
      expect(first?.expiresInMs).toBe(5 * 60 * 1000);
      expect(first?.targets).toHaveLength(1);
      expect(first?.targets[0].url).toContain("live.browser.run");

      // A second mint re-lists targets and gets a fresh URL — nothing cached.
      const second = await capability.liveView("checkout");
      expect(second?.targets[0].url).not.toBe(first?.targets[0].url);

      const devtools = await capability.liveView("checkout", {
        mode: "devtools"
      });
      expect(
        new URL(devtools?.targets[0].url ?? "").searchParams.get("mode")
      ).toBe("devtools");
    });
  });

  it("returns undefined Live View for unknown, closed, or dead sessions", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const binding = createFakeBrowserBinding();
      const { capability } = install(
        new BrowserSessions({ browser: binding.browser })
      );

      expect(await capability.liveView("never-created")).toBeUndefined();

      const resolved = await capability.resolve("checkout");
      binding.kill(resolved.sessionId);
      expect(await capability.liveView("checkout")).toBeUndefined();

      const replacement = await capability.resolve("checkout");
      expect(replacement.restarted).toBe(true);
      await capability.close("checkout");
      expect(await capability.liveView("checkout")).toBeUndefined();
    });
  });

  it("re-arms the sweep on startup when sessions outlived their job", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      // A prior life that died between the store write and the job push.
      const now = Date.now();
      await storage.put(durableKey("ghost"), {
        sessionId: "session-ghost",
        createdAt: now,
        updatedAt: now
      } satisfies StoredBrowserSession);

      const { browser } = createFakeBrowserBinding();
      const { lifecycle } = install(new BrowserSessions({ browser }));
      expect(await storage.getAlarm()).toBeNull();

      await lifecycle.start();
      expect(await storage.getAlarm()).not.toBeNull();
    });
  });

  it("coexists with a host job named 'sweep' — job ids are namespaced", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { browser } = createFakeBrowserBinding();
      const { capability, lifecycle } = install(
        new BrowserSessions({ browser })
      );
      // The docs teach hosts short generic job ids, and `cf_agents_jobs`
      // keys ids globally — a cross-owner collision throws. The capability's
      // sweep id must never contest a plausible host id.
      await lifecycle.jobs.push({
        id: "sweep",
        fn: "sweep",
        time: Date.now() + 60_000
      });

      await capability.resolve("checkout");

      const owners = storage.sql
        .exec("SELECT id, capability FROM cf_agents_jobs ORDER BY capability")
        .toArray();
      expect(owners).toEqual([
        { id: BROWSER_SWEEP_JOB_ID, capability: "browser" },
        { id: "sweep", capability: "host" }
      ]);
    });
  });

  it("re-arms the sweep when a session op overlaps a retiring dispatch", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { browser } = createFakeBrowserBinding();
      const { capability } = install(new BrowserSessions({ browser }));
      await capability.resolve("first");

      // The sweep is mid-dispatch (running = 1) and about to retire itself:
      // it listed an empty store, so its stale outcome will be `undefined`.
      storage.sql.exec(
        "UPDATE cf_agents_jobs SET running = 1, execution_started_at = ? WHERE id = ? AND capability = 'browser'",
        Date.now(),
        BROWSER_SWEEP_JOB_ID
      );

      // A session op lands inside that window. Its push must supersede the
      // running row so the stale delete defers to the newer schedule.
      await capability.resolve("checkout");
      new JobQueue(storage).applyOutcome(BROWSER_SWEEP_JOB_ID, undefined);

      const rows = storage.sql
        .exec(
          "SELECT running FROM cf_agents_jobs WHERE id = ? AND capability = 'browser'",
          BROWSER_SWEEP_JOB_ID
        )
        .toArray();
      expect(rows).toEqual([{ running: 0 }]);
    });
  });

  it("reschedules rather than retires the sweep on terminal failure", async () => {
    const { browser } = createFakeBrowserBinding();
    const sessions = new BrowserSessions({ browser, sweepIdleMs: 5_000 });
    const job: LifecycleJob = {
      id: BROWSER_SWEEP_JOB_ID,
      capability: "browser",
      fn: BROWSER_SWEEP_JOB_ID,
      time: 0,
      payload: undefined,
      retry: undefined,
      singleflight: true,
      exclusive: false,
      recoveryLoop: false,
      createdAt: 0
    };

    // A custom store outage that survives Lifecycle's in-process retries
    // must not delete the recurring job while entries may remain.
    const before = Date.now();
    const outcome = await sessions.onJobError(
      { job, attempt: 3 },
      new Error("remote store outage")
    );
    if (outcome === undefined || outcome === "yield") {
      throw new Error(`expected a reschedule outcome, got ${String(outcome)}`);
    }
    expect(outcome.rescheduleAt).toBeGreaterThanOrEqual(before + 5_000);
    expect(outcome.rescheduleAt).toBeLessThanOrEqual(Date.now() + 5_000);

    // Foreign job names complete normally.
    const foreign = await sessions.onJobError(
      { job: { ...job, fn: "other" }, attempt: 3 },
      new Error("unrelated")
    );
    expect(foreign).toBeUndefined();
  });
});

describe("BrowserSessions alarm-scheduled sweep", () => {
  it("sweeps idle sessions, prunes tombstones, then lets the alarm rest", async () => {
    const stub = env.BrowserHarnessObject.getByName(crypto.randomUUID());
    const pastIdle = Date.now() - BROWSER_HARNESS_SWEEP_IDLE_MS - 1000;

    await runInDurableObject(
      stub,
      async (instance: BrowserHarnessObject, state) => {
        const resolved = await instance.browser.resolve();
        expect(resolved.restarted).toBe(false);
        // Resolving armed the sweep job, which armed the physical alarm.
        expect(await state.storage.getAlarm()).not.toBeNull();

        // Make the session look idle past the window, and the sweep due now.
        await backdateStoredSession(state.storage, "default", {
          createdAt: pastIdle,
          updatedAt: pastIdle
        });
        backdateSweepJob(state.storage);
      }
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(
      stub,
      async (instance: BrowserHarnessObject, state) => {
        const stored = await state.storage.get<StoredBrowserSession>(
          durableKey("default")
        );
        expect(stored?.closedAt).toBeDefined();
        expect(
          instance.browserRequests.some(
            (request) => request.method === "DELETE"
          )
        ).toBe(true);
        // The tombstone still needs pruning — the sweep rescheduled itself.
        expect(await state.storage.getAlarm()).not.toBeNull();

        // Age the tombstone out and make the next sweep due now.
        await backdateStoredSession(state.storage, "default", {
          closedAt: pastIdle
        });
        backdateSweepJob(state.storage);
      }
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(
      stub,
      async (_instance: BrowserHarnessObject, state) => {
        expect(await state.storage.get(durableKey("default"))).toBeUndefined();
        // Nothing left to sweep: the job completed and the alarm is quiet.
        expect(await state.storage.getAlarm()).toBeNull();
      }
    );
  });
});

describe("BrowserSessions on an Agent subclass", () => {
  it("installs through the Agent's Lifecycle with the auto-supplied store", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());

    await runInDurableObject(
      stub,
      async (instance: TestBrowserAgent, state) => {
        const resolved = await instance.browser.resolve();
        expect(resolved.restarted).toBe(false);

        const stored = await state.storage.get<StoredBrowserSession>(
          durableKey("default")
        );
        expect(stored?.sessionId).toBe(resolved.sessionId);

        const views = await instance.browser.sessions();
        expect(views).toEqual([
          expect.objectContaining({ name: "default", status: "live" })
        ]);
      }
    );
  });
});
