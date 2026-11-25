import type {
  CapabilityStartContext,
  DurableObjectCapability
} from "./capability-runner";
import type { Connection } from "./types";
import type { LifecycleJobs } from "./job-queue";

type MaybePromise<T> = T | Promise<T>;

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

/** Startup state of a Lifecycle. */
export type LifecycleStatus = "zero" | "starting" | "started";

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
 */
export type LifecycleServices = {
  /** The host's Durable Object name; see `Lifecycle.name`. */
  readonly name: string;
  /** The host class name, as exported from the Worker. */
  readonly className: string;
  readonly storage: DurableObjectStorage;
  readonly sockets: LifecycleSockets;
  /**
   * Resolve once Lifecycle startup has finished, starting it if needed, and
   * reject if that startup fails. Calls made from inside startup resolve
   * immediately.
   *
   * Await it first in any operation that can run before startup and starts
   * work `onStart` also awaits, such as lazily opening a store. Native RPC
   * bypasses the automatic startup on fetch, alarm and WebSocket events, so
   * such an operation can begin that work outside startup. `onStart` then
   * awaits it while startup holds the input gate (`blockConcurrencyWhile`),
   * which holds back the work's timers and I/O, and startup times out after
   * 30 seconds and resets the object.
   */
  readonly ready: () => Promise<void>;
  /**
   * Startup state: `"zero"` before startup, `"starting"` while capability
   * and host startup hooks run, `"started"` once `ready()` resolves without
   * waiting.
   */
  readonly status: () => LifecycleStatus;
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
};

const installedServices = new WeakMap<object, LifecycleServices>();

/** A name an app gives an instance: `[a-z][a-z0-9-]{0,31}`. */
const INSTANCE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Names a composer derived ({@link LifecycleCapability.composedName}). */
const composedNames = new Set<string>();

/** The capabilities each capability composes, in the order it composed them. */
const composedBy = new WeakMap<LifecycleCapability, LifecycleCapability[]>();

/**
 * Storage names one capability instance owns. The default instance's are
 * today's names byte for byte; a named instance's carry its name, so two
 * instances of one kind never share a table, an index or a key.
 *
 * @internal
 */
export type LifecycleCapabilityStore = {
  /** The real name of this instance's table `name` (`cf_agents_<name>…`). */
  readonly table: (name: string) => string;
  /** The real name of this instance's index `name` (`idx_cf_agents_<name>…`). */
  readonly index: (name: string) => string;
  /** The real KV key for this instance's key `name` (`cf_agents:…<name>`). */
  readonly key: (name: string) => string;
};

/**
 * Base class for capabilities that consume standard Lifecycle services.
 */
export abstract class LifecycleCapability<Props extends object = object> {
  /**
   * The kind and, for a named instance, its name: `kind` or `kind/name`.
   * Jobs, events and storage names are derived from it.
   */
  readonly capabilityId: string;
  /** @internal The kind, fixed by the class (`"streams"`). */
  readonly kind: string;
  /** @internal The instance's name, or undefined for the default instance. */
  readonly instanceName: string | undefined;

  /** How this capability claims traffic; see {@link DurableObjectCapability.claims}. */
  readonly claims: "selective" | "catch-all" = "selective";

  protected constructor(kind: string, instanceName?: string) {
    if (kind.trim() === "") {
      throw new Error("Lifecycle capability IDs must be non-empty");
    }
    if (
      instanceName !== undefined &&
      !INSTANCE_NAME.test(instanceName) &&
      !composedNames.has(instanceName)
    ) {
      throw new Error(
        `${JSON.stringify(instanceName)} is not a valid instance name: use ` +
          "a lowercase letter, then up to 31 lowercase letters, digits or " +
          "hyphens."
      );
    }
    this.kind = kind;
    this.instanceName = instanceName;
    this.capabilityId =
      instanceName === undefined ? kind : `${kind}/${instanceName}`;
  }

  /**
   * @internal The name to give a capability this one composes: derived
   * from this instance's id, so it can never equal a name an app chose.
   */
  protected get composedName(): string {
    const name = `@${this.capabilityId}`;
    composedNames.add(name);
    return name;
  }

  /**
   * @internal Declare a capability this one builds on. `Lifecycle.use()`
   * installs it (and what it composes) before this one. Returns it.
   */
  protected compose<T extends LifecycleCapability>(capability: T): T {
    const list = composedBy.get(this) ?? [];
    list.push(capability);
    composedBy.set(this, list);
    return capability;
  }

  /**
   * This instance's storage names. Resolve them once (in the constructor)
   * and build statement text from them once.
   *
   * @internal
   */
  protected get store(): LifecycleCapabilityStore {
    return capabilityStore(this.capabilityId, this.instanceName);
  }

  /** Default startup hook; capabilities override when they own startup work. */
  onStart(_context: CapabilityStartContext<Props>): MaybePromise<void> {}

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

/**
 * @internal The storage names of instance `instanceName` (undefined for the
 * default). A table or index of a name an app chose ends `__n_<name>`, of
 * a derived one `__c_<name>`, with `-` as `_`, so the two never meet. A
 * named instance's KV keys are `cf_agents:<id>:<name>`.
 */
export function capabilityStore(
  capabilityId: string,
  instanceName: string | undefined
): LifecycleCapabilityStore {
  if (instanceName === undefined) {
    return {
      table: (name) => `cf_agents_${name}`,
      index: (name) => `idx_cf_agents_${name}`,
      key: (name) => `cf_agents:${name}`
    };
  }
  const suffix = instanceSuffix(instanceName);
  return {
    table: (name) => `cf_agents_${name}${suffix}`,
    index: (name) => `idx_cf_agents_${name}${suffix}`,
    key: (name) => `cf_agents:${capabilityId}:${name}`
  };
}

/**
 * @internal The storage-name suffix of a named instance. A chosen name
 * (`[a-z][a-z0-9-]*`) becomes `__n_<name>` with `-` as `_`. A derived name
 * (`@<composer id>`, which can hold `@`, `/` and `-`) becomes `__c_<name>`
 * with each of those escaped (`_a`, `_s`, `_h`), so no two names meet and
 * the result is a plain SQLite identifier.
 */
export function instanceSuffix(instanceName: string): string {
  if (!instanceName.startsWith("@")) {
    return `__n_${instanceName.replace(/-/g, "_")}`;
  }
  const escaped = instanceName
    .slice(1)
    .replace(/[@/-]/g, (char) =>
      char === "@" ? "_a" : char === "/" ? "_s" : "_h"
    );
  return `__c_${escaped}`;
}

/**
 * @internal The capabilities `capability` composes, then what each of
 * those composes, in install order: composed first, then the composer.
 */
export function capabilityInstallOrder(
  capability: LifecycleCapability
): LifecycleCapability[] {
  const order: LifecycleCapability[] = [];
  for (const composed of composedBy.get(capability) ?? []) {
    order.push(...capabilityInstallOrder(composed));
  }
  order.push(capability);
  return order;
}

/** @internal Read a capability ID without exposing installation internals. */
export function lifecycleCapabilityId(
  capability: DurableObjectCapability
): string | undefined {
  return capability instanceof LifecycleCapability
    ? capability.capabilityId
    : undefined;
}
