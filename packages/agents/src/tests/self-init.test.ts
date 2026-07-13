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

  it("initializes exactly once under two concurrent cold RPCs", async () => {
    const name = `self-init-concurrent-${crypto.randomUUID()}`;
    const stub = coldStub(env.SelfInitAgent, name);

    const [a, b] = await Promise.all([stub.probe(), stub.probe()]);

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
});
