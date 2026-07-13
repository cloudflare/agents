import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { routeAgentEmail } from "../index";
import type { SelfInitAgent, SelfInitEmailAgent } from "./worker";

// Every RPC entry surface of an Agent runs onStart() before executing, so a
// stub resolved WITHOUT the getAgentByName -> setName round-trip (a raw cold
// stub, or an internal zero-RTT resolution) still observes a fully
// initialized agent. These tests pin that guarantee.

function coldStub<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
  name: string
): DurableObjectStub<T> {
  // First-ever contact with this DO is a native RPC entry point — no
  // getAgentByName, no setName, no fetch/alarm/webSocket entry.
  return namespace.get(namespace.idFromName(name));
}

type AgentPathStep = { className: string; name: string };

// The internal facet RPC surfaces (`_cf_*`). These are NOT auto-wrapped by
// `withAgentContext` (the wrapper skips every `_`-prefixed / base-class
// method), so each carries its own `await this.__unsafe_ensureInitialized()`
// guard. A cold stub that reaches one of these must still observe a fully
// initialized agent.
interface InternalFacetSurface {
  _cf_scheduleForFacet(
    ownerPath: AgentPathStep[],
    when: number,
    callback: string
  ): Promise<unknown>;
  _cf_dispatchScheduledCallback(
    ownerPath: AgentPathStep[],
    row: unknown
  ): Promise<boolean>;
  _cf_broadcastToSubAgent(
    ownerPath: AgentPathStep[],
    message: string
  ): Promise<void>;
}

// Read the `name` row `onStart()` writes into the `self_init_probe` table,
// directly from durable SQL. `runInDurableObject` hands back the raw
// instance WITHOUT running an RPC entry surface, so — unlike `stub.probe()`
// — it does NOT itself trigger `onStart()` (verified: on a never-addressed
// cold instance it reads `onStartCount === 0` and no probe table). That
// makes this a faithful observer of whether the *internal* call under test
// ran init: with the guard the row is present, without it the table never
// exists and this returns null.
async function readSelfInitProbeName(
  stub: DurableObjectStub<SelfInitAgent>
): Promise<string | null> {
  return runInDurableObject(stub, (instance) => {
    const { sql } = (
      instance as unknown as {
        ctx: {
          storage: { sql: { exec: (q: string) => Iterable<{ v: string }> } };
        };
      }
    ).ctx.storage;
    try {
      const rows = [
        ...sql.exec("SELECT v FROM self_init_probe WHERE k = 'name'")
      ];
      return rows.at(0)?.v ?? null;
    } catch {
      // Table absent — `onStart()` never ran, so the guard did not fire.
      return null;
    }
  });
}

describe("RPC entry self-initialization", () => {
  it("initializes a cold stub before running a user-defined RPC method", async () => {
    const name = `self-init-user-${crypto.randomUUID()}`;
    const stub = coldStub(env.SelfInitAgent, name);

    const result = await stub.probe();

    // onStart ran exactly once, the schema it created is usable, and
    // this.name is correct.
    expect(result.onStartCount).toBe(1);
    expect(result.storedName).toBe(name);
    expect(result.name).toBe(name);
  });

  it("does not deadlock or double-init when onStart calls its own wrapped method", async () => {
    const name = `self-init-reentrant-${crypto.randomUUID()}`;
    const stub = coldStub(env.SelfInitAgent, name);

    const result = await stub.probe();

    // onStart called this.syncDouble(41) locally during init. That takes the
    // synchronous agent-context fast path: no deadlock, and onStart is NOT
    // re-entered.
    expect(result.onStartCount).toBe(1);
    expect(result.reentrantResult).toBe(83);
  });

  it("initializes exactly once across two overlapping cold RPCs", async () => {
    const name = `self-init-concurrent-${crypto.randomUUID()}`;
    const stub = coldStub(env.SelfInitAgent, name);

    const [a, b] = await Promise.all([stub.probe(), stub.probe()]);

    // This asserts the observable exactly-once contract (idempotence), NOT the
    // `_selfInitPromise` memo directly: the memo still passes this test if
    // removed. The first cold entry runs `__unsafe_ensureInitialized()`, whose
    // `blockConcurrencyWhile` holds the DO input gate shut until onStart
    // resolves; the second RPC therefore cannot begin executing until init is
    // already complete, at which point it takes the warm fast path. So true
    // concurrent cold entry — two calls in the wrapper's cold path before init
    // finishes — cannot be reproduced in-isolate here. The memo is
    // defense-in-depth for a genuine interleaving (partyserver's
    // `#ensureInitialized` re-runs onStart under a second entry — its
    // top-of-function status check is not re-evaluated inside
    // `blockConcurrencyWhile`), which is not what this test drives.
    expect(a.onStartCount).toBe(1);
    expect(b.onStartCount).toBe(1);
  });

  // Init-failure behavior (verified manually, not asserted here):
  //   When onStart() throws, a cold RPC entry surfaces the error to the
  //   caller (the wrapped call rejects with the onStart error) instead of
  //   hanging, and the in-flight init memo is cleared so the next call
  //   retries rather than replaying a cached rejection. partyserver catches
  //   the onStart throw inside blockConcurrencyWhile and rethrows it after
  //   the critical section, so the DO is NOT reset — the status stays
  //   uninitialized and the next entry re-runs onStart.
  //
  //   This is intentionally not a runnable test: an onStart that rejects
  //   inside partyserver's blockConcurrencyWhile makes workerd log an
  //   "uncaught (in promise)" that @cloudflare/vitest-pool-workers reports
  //   as an unhandled error and fails the run. That artifact reproduces
  //   identically on the pre-existing getServerByName -> setName round-trip
  //   path, so it is a harness limitation, not a behavior this PR changes.

  it("preserves synchronous return values for wrapped methods once warm", async () => {
    const name = `self-init-sync-${crypto.randomUUID()}`;
    const stub = coldStub(env.SelfInitAgent, name);

    // Warm the agent up (cold init happens here).
    await stub.probe();

    const observed = await runInDurableObject(
      stub as DurableObjectStub<SelfInitAgent>,
      (instance) => {
        // A synchronous wrapped method called after init must return its
        // value synchronously, not a promise.
        const direct = instance.syncDouble(21);
        // A synchronous wrapped method called locally from another method
        // (agent-context fast path) must also stay synchronous.
        const local = instance.callSyncLocally();
        return {
          // Cast through `unknown`: statically these are already non-promise
          // types, but the check exists to catch a runtime regression where a
          // warm wrapped method starts returning a promise.
          directIsPromise: (direct as unknown) instanceof Promise,
          direct,
          localIsPromise: (local as unknown) instanceof Promise,
          local
        };
      }
    );

    expect(observed.directIsPromise).toBe(false);
    expect(observed.direct).toBe(42);
    expect(observed.localIsPromise).toBe(false);
    expect(observed.local.innerWasNumber).toBe(true);
    expect(observed.local.value).toBe(43);
  });

  it("initializes a cold stub before dispatching _onEmail", async () => {
    const agentId = `self-init-email-${crypto.randomUUID()}`;
    const email = {
      from: "cold@example.com",
      to: "recipient@example.com",
      headers: new Headers(),
      raw: new ReadableStream(),
      rawSize: 1024,
      setReject: () => {},
      forward: async () => ({ messageId: "mock-forward-id" }),
      reply: async () => ({ messageId: "mock-reply-id" })
    } as unknown as ForwardableEmailMessage;

    // routeAgentEmail resolves the agent stub zero-RTT and calls _onEmail;
    // _onEmail self-initializes. If it did not, onEmail's INSERT into the
    // onStart-created table would throw and this call would reject.
    await routeAgentEmail(email, env, {
      resolver: async () => ({ agentName: "SelfInitEmailAgent", agentId })
    });

    const stub = env.SelfInitEmailAgent.get(
      env.SelfInitEmailAgent.idFromName(agentId)
    ) as DurableObjectStub<SelfInitEmailAgent>;
    const probe = await runInDurableObject(stub, (instance) =>
      instance.emailProbe()
    );

    expect(probe.onStartCount).toBe(1);
    expect(probe.storedFrom).toBe("cold@example.com");
  });

  it("allows deleteSubAgent() from inside onStart() on a non-facet agent", async () => {
    // Regression: on a top-level (non-facet) agent, `deleteSubAgent()` runs
    // `_cf_cleanupFacetPrefix`'s work locally. Once that method
    // self-initialized on RPC entry, calling it during onStart re-entered
    // framework init and threw "blockConcurrencyWhile() calls are nested too
    // deeply", aborting init. The local path now routes to the unguarded
    // `_cleanupFacetPrefixImpl`, so onStart completes.
    const name = `self-init-delete-onstart-${crypto.randomUUID()}`;
    const stub = coldStub(env.SelfInitDeleteInOnStartAgent, name);

    // A cold probe forces onStart; if the regression returns, onStart rejects
    // and this call rejects with it.
    const result = await stub.probe();

    expect(result.onStartCount).toBe(1);
    expect(result.completed).toBe("yes");
  });
});

// The bulk of the self-init work is ~22 internal `_cf_*` facet RPC surfaces,
// each guarded by its own `await this.__unsafe_ensureInitialized()`. The
// warm sub-agent / schedule suites only ever reach these once the DO is
// already initialized (the parent addresses the facet first), so a dropped
// guard is invisible there. These tests exercise the real cold flow: the
// first-ever contact with the DO is one of these internal surfaces. Each
// asserts that `onStart()`'s durable side effect (the `self_init_probe`
// row) exists afterwards — which only holds if the surface ran init.
describe("RPC entry self-initialization (internal facet surfaces)", () => {
  it("initializes a cold stub before a facet-schedule write (_cf_scheduleForFacet)", async () => {
    const name = `self-init-cf-schedule-${crypto.randomUUID()}`;
    const stub = coldStub(env.SelfInitAgent, name);
    const selfPath: AgentPathStep[] = [{ className: "SelfInitAgent", name }];

    // First-ever contact is the internal schedule-write RPC. Its target
    // table (`cf_agents_schedules`) is created in the constructor, not
    // `onStart()`, so the insert would succeed even with the guard dropped —
    // the guard is proven only by the onStart-created probe row below.
    // A number `when` is a delay in seconds; 1 hour keeps the alarm from
    // firing inside the test window.
    await (stub as unknown as InternalFacetSurface)._cf_scheduleForFacet(
      selfPath,
      3600,
      "noop"
    );

    expect(await readSelfInitProbeName(stub)).toBe(name);
  });

  it("initializes a cold stub before a dispatched callback (_cf_dispatchScheduledCallback)", async () => {
    const name = `self-init-cf-dispatch-${crypto.randomUUID()}`;
    const stub = coldStub(env.SelfInitAgent, name);
    // A path one level below self, addressing a sub-agent that was never
    // spawned: the dispatch walks one step, finds no such child, and prunes
    // the stale prefix (returns false) — reaching the branch WITHOUT needing
    // a real callback row. `selfPath` is only correct once `onStart()` has
    // hydrated the agent, so a dropped guard breaks this path.
    const ownerPath: AgentPathStep[] = [
      { className: "SelfInitAgent", name },
      { className: "NoSuchChild", name: "absent" }
    ];

    const executed = await (
      stub as unknown as InternalFacetSurface
    )._cf_dispatchScheduledCallback(ownerPath, {});

    expect(executed).toBe(false);
    expect(await readSelfInitProbeName(stub)).toBe(name);
  });

  it("initializes a cold stub before a sub-agent broadcast (_cf_broadcastToSubAgent)", async () => {
    const name = `self-init-cf-broadcast-${crypto.randomUUID()}`;
    const stub = coldStub(env.SelfInitAgent, name);
    const selfPath: AgentPathStep[] = [{ className: "SelfInitAgent", name }];

    // No connections exist, so the broadcast is a no-op — but reaching it at
    // all depends on `_isFacet`/connection state that only `onStart()`
    // hydrates, and the surface must self-initialize first.
    await (stub as unknown as InternalFacetSurface)._cf_broadcastToSubAgent(
      selfPath,
      "hello"
    );

    expect(await readSelfInitProbeName(stub)).toBe(name);
  });
});
