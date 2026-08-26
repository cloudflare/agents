import type {
  CapabilityStartContext,
  DurableObjectCapability
} from "./capability-runner";

/** Opaque address understood by a Lifecycle routing transport. */
export type LifecycleRouteAddress = {
  /** Stable equality and storage key. */
  readonly key: string;
  /** Transport-owned serialized address. */
  readonly data: string;
};

/** Context supplied with a routed capability message. */
export type LifecycleRouteContext = {
  /** Address of the sending Lifecycle, or undefined for an unrouted root. */
  readonly source: LifecycleRouteAddress | undefined;
  /** Capability-owned message payload. */
  readonly payload: unknown;
};

/** Alarm coordination available to every Lifecycle capability. */
export type LifecycleAlarms = {
  /** Recompute the physical alarm from installed capability state. */
  readonly rearm: () => Promise<void>;
  /**
   * True once explicit host teardown permanently disabled alarm arming.
   * Capabilities stop dispatching durable work when this reports true.
   */
  readonly disabled: () => boolean;
};

/**
 * Named host-callback dispatch available to every Lifecycle capability.
 *
 * User callbacks run inside the host invocation context, unlike capability
 * hooks. Lifecycle owns that transition so every capability invokes host
 * methods through one boundary.
 */
export type LifecycleHostCallbacks = {
  /** True when the host exposes a callable method with this name. */
  readonly has: (name: string) => boolean;
  /** Invoke a named host callback inside the host invocation context. */
  readonly invoke: (name: string, args: readonly unknown[]) => Promise<unknown>;
};

/** Best-effort telemetry available to every Lifecycle capability. */
export type LifecycleEvents = {
  /** Publish an event under this capability's stable identity. */
  readonly emit: (type: string, payload: unknown) => void;
};

/** Routing available to every Lifecycle capability. */
export type LifecycleRoutes = {
  /** This Lifecycle's transport address, or undefined at the route root. */
  readonly source: LifecycleRouteAddress | undefined;
  /** Route a capability-owned message to the root Lifecycle. */
  readonly toRoot: (payload: unknown) => Promise<unknown>;
  /** Route a capability-owned message to another Lifecycle. */
  readonly to: (
    target: LifecycleRouteAddress,
    payload: unknown
  ) => Promise<unknown>;
};

/** Standard services granted to every installed Lifecycle capability. */
export type LifecycleServices = {
  readonly storage: DurableObjectStorage;
  readonly ready: () => Promise<void>;
  /** True while capability and host startup hooks are still running. */
  readonly starting: () => boolean;
  readonly alarms: LifecycleAlarms;
  readonly callbacks: LifecycleHostCallbacks;
  readonly events: LifecycleEvents;
  readonly routes: LifecycleRoutes;
};

const installedServices = new WeakMap<object, LifecycleServices>();
const declaredHosts = new WeakMap<object, object>();

/** Base class for capabilities that consume standard Lifecycle services. */
export abstract class LifecycleCapability<Props extends object = object> {
  readonly capabilityId: string;

  /**
   * @param capabilityId - Stable identity used for events and routing.
   * @param host - The host object this capability was constructed for, when
   * it binds to one. `Lifecycle.use()` verifies it is the same object the
   * Lifecycle owns, so a capability's compile-time host typing can never
   * diverge from its runtime dispatch target.
   */
  protected constructor(capabilityId: string, host?: object) {
    if (capabilityId.trim() === "") {
      throw new Error("Lifecycle capability IDs must be non-empty");
    }
    this.capabilityId = capabilityId;
    if (host !== undefined) declaredHosts.set(this, host);
  }

  /** Default startup hook; capabilities override when they own startup work. */
  onStart(_context: CapabilityStartContext<Props>): void {}

  /** Standard services when installed, or undefined in isolated unit tests. */
  protected get lifecycleServices(): LifecycleServices | undefined {
    return installedServices.get(this);
  }

  /** Standard services supplied when Lifecycle installs this capability. */
  protected get lifecycle(): LifecycleServices {
    const services = this.lifecycleServices;
    if (!services) {
      throw new Error(
        `${this.constructor.name} must be installed with Lifecycle.use() before use`
      );
    }
    return services;
  }
}

/**
 * @internal Bind the standard service surface to one capability instance.
 * `Lifecycle.use()` calls this during installation. Test a capability by
 * installing it on a minimal Durable Object with a real Lifecycle rather
 * than binding fake services.
 */
export function bindLifecycleCapability(
  capability: LifecycleCapability,
  services: LifecycleServices
): void {
  installedServices.set(capability, services);
}

/** @internal The host a capability was constructed for, when it declared one. */
export function lifecycleCapabilityHost(
  capability: DurableObjectCapability
): object | undefined {
  return capability instanceof LifecycleCapability
    ? declaredHosts.get(capability)
    : undefined;
}

/** @internal Read a capability ID without exposing installation internals. */
export function lifecycleCapabilityId(
  capability: DurableObjectCapability
): string | undefined {
  return capability instanceof LifecycleCapability
    ? capability.capabilityId
    : undefined;
}
