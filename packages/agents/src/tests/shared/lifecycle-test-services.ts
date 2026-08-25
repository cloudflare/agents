import {
  bindLifecycleCapability,
  type LifecycleCapability
} from "../../lifecycle/capability";
import type { LifecycleServices } from "../../lifecycle";

/**
 * Bind minimal fake Lifecycle services to a capability constructed outside a
 * Durable Object. This exists for the legacy MCP manager suites built on
 * hand-rolled mock storage; storage is the only live dependency, readiness
 * resolves immediately, and the alarm, host-callback, and routing services
 * are inert.
 *
 * New capability tests should not use this: install the capability on a
 * minimal Durable Object with a real Lifecycle instead (see
 * `tests/lifecycle/scheduler-capability.test.ts`), which exercises real
 * storage, alarms, host context, and events.
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
