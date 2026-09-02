import type {
  CapabilityStartContext,
  DurableObjectCapability
} from "./capability-runner";
import type { Connection } from "./types";
import type { LifecycleJobs } from "./job-queue";

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

/**
 * Ambient scope a capability supplies when entering host context on
 * behalf of a live connection or request.
 */
export type LifecycleHostContextScope = {
  /** The connection the callback runs on behalf of, when there is one. */
  readonly connection?: Connection;
  /** The request the callback runs on behalf of, when there is one. */
  readonly request?: Request;
};

/**
 * The platform's hibernatable-socket surface, exposed narrowly so a
 * capability that owns connections (e.g. WebSockets) can accept and
 * enumerate them without holding the whole `DurableObjectState`.
 * These are workerd API names, not Lifecycle modeling sockets.
 */
export type LifecycleSockets = {
  /** Accept a socket into hibernation under the given tags. */
  readonly accept: (ws: WebSocket, tags: string[]) => void;
  /** Every hibernated socket on the object, optionally by tag. */
  readonly get: (tag?: string) => WebSocket[];
};

/**
 * Standard services granted to every installed Lifecycle capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type LifecycleServices = {
  readonly storage: DurableObjectStorage;
  readonly sql: <T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => T[];
  /** Register non-blocking work with the host execution context. */
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly sockets: LifecycleSockets;
  readonly ready: () => Promise<void>;
  /** True while capability and host startup hooks are still running. */
  readonly starting: () => boolean;
  /**
   * This capability's scoped access to the Lifecycle-owned work queue.
   * Pushed items are dispatched to `onJob` when due; every queue mutation
   * re-arms the physical alarm automatically.
   */
  readonly jobs: LifecycleJobs;
  /**
   * Run a capability-held user callback inside the host invocation context.
   * Capability hooks run outside host context; this is the one boundary for
   * entering it, and a host composition root may substitute its own wrapper
   * (Agent adds tracing span scope). Pass `scope` to make a live
   * connection or request ambient for the callback.
   */
  readonly runInHostContext: (
    fn: () => unknown,
    scope?: LifecycleHostContextScope
  ) => Promise<unknown>;
  readonly events: LifecycleEvents;
  readonly routes: LifecycleRoutes;
};

const installedServices = new WeakMap<object, LifecycleServices>();

/**
 * Base class for capabilities that consume standard Lifecycle services.
 *
 * @experimental The API surface may change before stabilizing.
 */
export abstract class LifecycleCapability<Props extends object = object> {
  readonly capabilityId: string;

  protected constructor(capabilityId: string) {
    if (capabilityId.trim() === "") {
      throw new Error("Lifecycle capability IDs must be non-empty");
    }
    this.capabilityId = capabilityId;
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

/** @internal Read a capability ID without exposing installation internals. */
export function lifecycleCapabilityId(
  capability: DurableObjectCapability
): string | undefined {
  return capability instanceof LifecycleCapability
    ? capability.capabilityId
    : undefined;
}
