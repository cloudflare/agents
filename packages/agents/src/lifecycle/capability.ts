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
  /**
   * False when a `bootstrap` envelope reached this Lifecycle before it
   * started. The receiving capability then writes whatever startup must
   * observe and calls `lifecycle.ready()` itself.
   */
  readonly started: boolean;
};

/** Envelope transported between routed Lifecycle instances. */
export type LifecycleRouteEnvelope = {
  readonly capability: string;
  readonly source: LifecycleRouteAddress | undefined;
  readonly payload: unknown;
  /**
   * Deliver before startup when the receiving Lifecycle has not started,
   * instead of starting it first. Ignored once it has started. For
   * messages that establish state startup itself depends on (a child's
   * identity, for example).
   */
  readonly bootstrap?: boolean;
};

/**
 * Transport supplied by the capability that owns routed child Lifecycles
 * (see `DurableObjectCapability.provideRouteTransport`).
 */
export type LifecycleRouteTransport = {
  /** This Lifecycle's address, or undefined at the route root. */
  readonly source: LifecycleRouteAddress | undefined;
  readonly toRoot: (envelope: LifecycleRouteEnvelope) => Promise<unknown>;
  readonly to: (
    target: LifecycleRouteAddress,
    envelope: LifecycleRouteEnvelope
  ) => Promise<unknown>;
};

/** Inbound side of a Lifecycle route transport. */
export type LifecycleRouteInbound = {
  /**
   * Hand an envelope to this Lifecycle. Envelopes handed over while startup
   * is running are delivered, in order, once startup completes.
   */
  readonly deliver: (envelope: LifecycleRouteEnvelope) => Promise<unknown>;
};

/**
 * A retired routed subtree: the address and every address beneath it no
 * longer exist, so capabilities drop the durable work they mirror for
 * those owners.
 */
export type LifecycleRouteRetirement = {
  /** The retired address. */
  readonly address: LifecycleRouteAddress;
  /** Whether an owner key (an address `key`) falls under this retirement. */
  readonly covers: (ownerKey: string) => boolean;
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
  /**
   * Announce that a routed subtree no longer exists. Every installed
   * capability's `onRouteRetired` runs, in order, so mirrors keyed by the
   * retired owners are dropped.
   */
  readonly retire: (retirement: LifecycleRouteRetirement) => Promise<void>;
};

/**
 * The platform's facet surface (`ctx.facets`), exposed narrowly so a
 * capability can spawn colocated child Durable Objects without holding the
 * whole `DurableObjectState`.
 */
export type LifecycleFacets = {
  /** False when the runtime predates facets; the other members then throw. */
  readonly supported: boolean;
  readonly get: (
    key: string,
    startup: () => { class: DurableObjectClass; id: DurableObjectId }
  ) => Fetcher;
  readonly abort: (key: string, reason?: unknown) => void;
  readonly delete: (key: string) => void;
};

/**
 * The worker's exports (`ctx.exports`), exposed narrowly: class lookup for
 * facet startup and loopback namespaces for addressing top-level objects.
 */
export type LifecycleExports = {
  /** False when the runtime predates `ctx.exports`. */
  readonly supported: boolean;
  /** Export names, for matching URL segments to classes. */
  readonly names: () => readonly string[];
  /** The Durable Object class exported under `name`, if any. */
  readonly durableObjectClass: (name: string) => DurableObjectClass | undefined;
  /** The loopback namespace under `name`, when that export is a bound class. */
  readonly namespace: (name: string) => DurableObjectNamespace | undefined;
};

/** Identity of the object this Lifecycle belongs to. */
export type LifecycleObjectIdentity = {
  /** The routed name (`Lifecycle.name`). */
  readonly name: () => string;
  /** The host class name. */
  readonly className: string;
  /** Whether `id` addresses this very object. */
  readonly isSelf: (id: DurableObjectId) => boolean;
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
   * Keep work this capability hands off at a bounded `onJob` return inside
   * the current alarm's memory-limit breaker domain (#1825). Returns false,
   * tracking nothing, outside an alarm invocation.
   */
  readonly trackAlarmWork: (work: Promise<unknown>) => boolean;
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
  readonly facets: LifecycleFacets;
  readonly exports: LifecycleExports;
  readonly object: LifecycleObjectIdentity;
  /** Extend the current invocation until `work` settles. */
  readonly waitUntil: (work: Promise<unknown>) => void;
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
