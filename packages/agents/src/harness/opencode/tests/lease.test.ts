import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEASE_TTL_MS,
  LEASE_FN,
  SessionLeases,
  leaseJobId,
  leasePayload,
  type LeasePayload
} from "../lease";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Lifecycle, LifecycleCapability } from "../../../lifecycle";

/**
 * The lease's own rules, over a real Lifecycle job queue.
 *
 * `SessionLeases` is the whole durable surface of the lease: one job per
 * session, armed on admission, pushed out by log events, cancelled by a
 * terminal. Testing it directly needs no OpenCode host and no model.
 */

/** A bare capability, just to own a job queue. */
class Owner extends LifecycleCapability {
  constructor() {
    super("opencode-harness");
  }

  get jobs() {
    return this.lifecycle.jobs;
  }
}

async function withLeases<T>(
  options: { ttlMs?: number; stallLimit?: number },
  body: (context: {
    leases: SessionLeases;
    jobs: Lifecycle["jobs"];
  }) => Promise<T>
): Promise<T> {
  // A bare object, so the lease runs over a real Lifecycle job queue.
  const stub = env.OPENCODE_LEASE_TEST.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (instance) => {
    const capability = new Owner();
    const lifecycle = new Lifecycle(instance).use(capability);
    await lifecycle.start();
    const jobs = capability.jobs;
    return body({ leases: new SessionLeases({ jobs, ...options }), jobs });
  });
}

function payloadOf(
  jobs: Lifecycle["jobs"],
  session: string
): LeasePayload | undefined {
  const job = jobs.get(leaseJobId(session));
  return job ? leasePayload(job) : undefined;
}

describe("SessionLeases", () => {
  it("arms one job per session, due a full ttl out", async () => {
    await withLeases({ ttlMs: 60_000 }, async ({ leases, jobs }) => {
      const before = Date.now();
      await leases.arm("ses_1", "admitting", 5);

      const job = jobs.get(leaseJobId("ses_1"));
      expect(job?.fn).toBe(LEASE_FN);
      expect(job?.time).toBeGreaterThanOrEqual(before + 60_000);
      expect(leasePayload(job!)).toEqual({
        session: "ses_1",
        kind: "admitting",
        position: 5,
        stalls: 0
      });

      // One job per session, not one per arm.
      await leases.arm("ses_1", "admitting", 6);
      expect(jobs.list().filter((row) => row.fn === LEASE_FN)).toHaveLength(1);
    });
  });

  it("never downgrades a claimed lease to admitting", async () => {
    // Once OpenCode owns the turn, a later submit must not make the lease
    // think it still has a prompt to hand over.
    await withLeases({}, async ({ leases, jobs }) => {
      await leases.arm("ses_1", "claimed", 1);
      await leases.arm("ses_1", "admitting", 2);
      expect(payloadOf(jobs, "ses_1")?.kind).toBe("claimed");
    });
  });

  it("extends only once less than half the ttl is left", async () => {
    await withLeases({ ttlMs: 60_000 }, async ({ leases, jobs }) => {
      await leases.arm("ses_1", "claimed", 1);
      const armed = jobs.get(leaseJobId("ses_1"))!.time;

      // Fresh lease, no progress: the write is skipped, so a busy turn does
      // not write storage once per log event.
      await leases.extend("ses_1", 1);
      expect(jobs.get(leaseJobId("ses_1"))?.time).toBe(armed);

      // Progress always extends, so the position in the payload advances.
      await leases.extend("ses_1", 9);
      expect(payloadOf(jobs, "ses_1")?.position).toBe(9);
    });
  });

  it("does not extend a lease that is not held", async () => {
    await withLeases({}, async ({ leases, jobs }) => {
      await leases.extend("ses_1", 3);
      expect(jobs.get(leaseJobId("ses_1"))).toBeUndefined();
    });
  });

  it("releases the lease, leaving no job", async () => {
    await withLeases({}, async ({ leases, jobs }) => {
      await leases.arm("ses_1", "claimed", 1);
      expect(await leases.release("ses_1")).toBe(true);
      expect(jobs.get(leaseJobId("ses_1"))).toBeUndefined();
      expect(await leases.release("ses_1")).toBe(false);
    });
  });

  it("counts a stall only when the log did not move", async () => {
    // A long silent tool keeps the session active with no new events, so
    // those fires must not count — otherwise the lease would be dropped in
    // the middle of the tool.
    await withLeases({ stallLimit: 5 }, async ({ leases }) => {
      const held: LeasePayload = {
        session: "ses_1",
        kind: "claimed",
        position: 7,
        stalls: 2
      };
      expect(leases.nextStalls(held, 7)).toBe(3);
      expect(leases.nextStalls(held, 8)).toBe(0);
      expect(leases.stalled(4)).toBe(false);
      expect(leases.stalled(5)).toBe(true);
    });
  });

  it("keeps the stall count when arming a lease it already holds", async () => {
    // A fire reconciles — and so may re-arm — before deciding whether the
    // lease has stalled. Arming must not wipe the counter that decision
    // needs, or the backstop could never trigger.
    await withLeases({}, async ({ leases, jobs }) => {
      await leases.renew("ses_1", "claimed", 4, 3);
      await leases.arm("ses_1", "admitting", 4);
      expect(payloadOf(jobs, "ses_1")?.stalls).toBe(3);

      // Real progress still resets it.
      await leases.arm("ses_1", "admitting", 5);
      expect(payloadOf(jobs, "ses_1")?.stalls).toBe(0);
    });
  });

  it("lists every held lease", async () => {
    await withLeases({}, async ({ leases }) => {
      await leases.arm("ses_1", "admitting", 1);
      await leases.arm("ses_2", "claimed", 2);
      expect(
        leases
          .list()
          .map((lease) => `${lease.session}:${lease.kind}`)
          .sort()
      ).toEqual(["ses_1:admitting", "ses_2:claimed"]);
    });
  });

  it("defaults its ttl and rejects a nonsensical one", async () => {
    await withLeases({}, async ({ jobs }) => {
      expect(new SessionLeases({ jobs }).ttlMs).toBe(DEFAULT_LEASE_TTL_MS);
      expect(() => new SessionLeases({ jobs, ttlMs: 0 })).toThrow(
        "lease.ttlMs"
      );
      expect(() => new SessionLeases({ jobs, stallLimit: -1 })).toThrow(
        "lease.stallLimit"
      );
    });
  });
});
