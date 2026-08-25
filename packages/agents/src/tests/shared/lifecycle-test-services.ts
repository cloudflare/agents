import {
  bindLifecycleCapability,
  type LifecycleCapability,
  type LifecycleServices
} from "../../lifecycle";

/**
 * Bind minimal fake Lifecycle services to a capability so it can be exercised
 * standalone in unit tests. Storage is the only live dependency; readiness
 * resolves immediately, while alarm, host-callback, and routing services are
 * inert. Tests that assert on rearm requests, events, or callback dispatch
 * should bind their own recording services instead.
 */
export function bindTestLifecycleServices(
  capability: LifecycleCapability,
  storage: DurableObjectStorage
): void {
  const services: LifecycleServices = {
    storage,
    ready: async () => {},
    starting: () => false,
    alarms: {
      rearm: async () => {},
      disabled: () => false
    },
    callbacks: {
      has: () => false,
      invoke: async (name) => {
        throw new Error(
          `Test lifecycle services cannot invoke host callback ${name}`
        );
      }
    },
    events: {
      emit: () => {}
    },
    routes: {
      source: undefined,
      toRoot: async () => {
        throw new Error("Test lifecycle services have no route transport");
      },
      to: async () => {
        throw new Error("Test lifecycle services have no route transport");
      }
    }
  };
  bindLifecycleCapability(capability, services);
}
