import { runInDurableObject } from "cloudflare:test";
import { env, DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../../lifecycle";

/**
 * Bare Durable Object for capability tests that need real storage and real
 * Lifecycle services but construct their capabilities per test (for example
 * to vary constructor options). Registered in the workers test project;
 * drive it through {@link withCapabilityHarness}.
 */
export class CapabilityHarnessObject extends DurableObject<Cloudflare.Env> {}

/** What a capability-harness test body receives. */
export type CapabilityHarness = {
  /** The harness object's real Durable Object storage. */
  readonly storage: DurableObjectStorage;
  /**
   * Bind a capability to this object through a real Lifecycle and return it.
   * Services (storage, alarms, callbacks, events, routes) are live from this
   * point; startup hooks run only if the test starts the returned lifecycle.
   */
  readonly install: <Capability extends DurableObjectCapability>(
    capability: Capability
  ) => { capability: Capability; lifecycle: Lifecycle };
};

/**
 * Run one test body against a fresh bare Durable Object, installing
 * capabilities through a real Lifecycle over real SQLite storage.
 *
 * This is the isolation half of the capability testing pattern: no fakes, no
 * runtime handlers — the test drives the capability's own API directly.
 * Tests that need real platform dispatch (alarms firing, fetch routing) use
 * a dedicated harness object with the capability installed as a field
 * instead (see `scheduler-harness.ts`).
 */
export async function withCapabilityHarness<T>(
  fn: (harness: CapabilityHarness) => Promise<T> | T
): Promise<T> {
  const stub = env.CapabilityHarnessObject.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (instance, state) =>
    fn({
      storage: state.storage,
      install: (capability) => ({
        capability,
        lifecycle: new Lifecycle(instance).use(capability)
      })
    })
  );
}
