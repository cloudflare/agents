import { lifecycleCapabilityId } from "./capability";
import type { LifecycleRouteContext } from "./capability";
import type { WSMessage } from "./types";
import type {
  LifecycleJob,
  LifecycleJobContext,
  LifecycleJobOutcome
} from "./job-queue";

type MaybePromise<T> = T | Promise<T>;

/** One best-effort event published by a Lifecycle capability. */
export type LifecycleEvent = {
  /** Stable capability or subsystem name. */
  readonly source: string;
  /** Stable event name within that source. */
  readonly type: string;
  /** Event-specific data. */
  readonly payload: unknown;
};

/** Terminal sink for best-effort Lifecycle events. */
export type LifecycleEventSink = (
  event: LifecycleEvent
) => void | Promise<void>;

/** Context supplied when durable capabilities start. */
export type CapabilityStartContext<Props extends object = object> = {
  /** Properties supplied while resolving the Durable Object. */
  readonly props: Props | undefined;
};

/** Context supplied when durable capabilities inspect an HTTP request. */
export type CapabilityRequestContext = {
  /** The request entering the Durable Object. */
  readonly request: Request;
};

/** Context supplied when a capability inspects a WebSocket upgrade. */
export type CapabilityWebSocketUpgradeContext = {
  /** The WebSocket upgrade request entering the Durable Object. */
  readonly request: Request;
};

/**
 * Context supplied when the alarm memory-limit circuit breaker records a
 * strike (#1825), to capabilities and the host alike.
 */
export type MemoryLimitContext = {
  /** Whether the breaker hit its strike budget and sealed recovery work. */
  readonly sealed: boolean;
  /** The backoff wake time (epoch ms) armed for an unsealed strike. */
  readonly nextTime?: number;
  /**
   * The queue job that was executing when the strike landed. Absent when the
   * reset happened during startup or host alarm work. Lifecycle has already
   * backed off or purged its row before invoking memory-limit policy.
   *
   * Capabilities whose durable state outlives their queue row use this to
   * apply the same policy to the underlying work — Tasks routes a struck
   * routed job's owner this way (see `setTaskRoutedMemoryLimitHandler`).
   */
  readonly executing?: LifecycleJob;
  /**
   * Recovery-loop jobs removed when this strike sealed the breaker. This is
   * a pre-purge snapshot because the durable rows no longer exist when
   * policy hooks run. No current capability reads this — Scheduler's own
   * former use of it (routing a sealed strike to every purged row's owning
   * dynamic agent) was retired once Tasks took over routed chat-recovery
   * wakes — but it stays available for a capability whose routed rows can
   * be purged as a pack, unlike Tasks' one-run-at-a-time model.
   */
  readonly purgedRecoveryLoopJobs?: ReadonlyArray<LifecycleJob>;
};

/**
 * A capability installed into a Durable Object lifecycle.
 *
 * Capabilities extending `LifecycleCapability` receive the standard storage,
 * readiness, alarm, event, and routing surface. Host-specific bindings and
 * protocol adapters remain explicit constructor dependencies. Hook parameters
 * carry only phase data; hooks do not run in ambient host context — a
 * capability-held user callback re-enters host context exactly once,
 * through `LifecycleServices.runInHostContext(fn, scope)`.
 *
 * A capability interacts with Lifecycle through exactly three channels:
 * these declared hooks, the `LifecycleServices` surface, and
 * composition-root `set*()` apertures. Any other direct reach in either
 * direction is a design smell.
 *
 * Dispatch contract, hook by hook:
 * - `onRequest` and `onWebSocketUpgrade` are offered in declaration
 *   order, fallbacks last; the first capability to return a `Response`
 *   claims the request, and a claimed upgrade's socket belongs to that
 *   capability for its whole lifetime.
 * - `onWebSocketMessage`/`onWebSocketClose`/`onWebSocketError` are
 *   platform wakes, offered in declaration order; return `true` to
 *   consume one. Socket ownership is the capability's to determine —
 *   keep a private hibernation-attachment namespace and recognize your
 *   own sockets by it.
 * - `onRoute` is addressed to one capability by its id; `onJob` is
 *   addressed by the due job's owning capability, with Lifecycle owning
 *   the queue and the one physical alarm.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface DurableObjectCapability<Props extends object = object> {
  /** Initialize or recover the capability before the host handles work. */
  onStart?(context: CapabilityStartContext<Props>): MaybePromise<void>;

  /**
   * Act as middleware over HTTP requests, ahead of the host's request handler.
   *
   * Return a response to handle the request, or `undefined` to pass it to the
   * next capability and finally the host.
   */
  onRequest?(
    context: CapabilityRequestContext
  ): MaybePromise<Response | undefined | void>;

  /**
   * Claim a WebSocket upgrade before the host's legacy connection path.
   *
   * A capability that returns a response owns that socket and its lifetime,
   * including any hibernation attachment it needs to recognize the socket
   * later. Return `undefined` to decline.
   */
  onWebSocketUpgrade?(
    context: CapabilityWebSocketUpgradeContext
  ): MaybePromise<Response | undefined | void>;

  /**
   * Handle a platform `webSocketMessage` wake for a socket this capability
   * owns. Return `true` to consume the event; anything else offers it to
   * the next capability and finally the host's legacy path. Ownership is
   * the capability's to determine — typically via its own hibernation
   * attachment namespace.
   */
  onWebSocketMessage?(
    ws: WebSocket,
    message: WSMessage
  ): MaybePromise<boolean | void>;

  /** Handle a platform `webSocketClose` wake for an owned socket. */
  onWebSocketClose?(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): MaybePromise<boolean | void>;

  /** Handle a platform `webSocketError` wake for an owned socket. */
  onWebSocketError?(
    ws: WebSocket,
    error: unknown
  ): MaybePromise<boolean | void>;

  /**
   * Drive one due job this capability pushed into the Lifecycle queue.
   * Return an outcome to reschedule or retain the job; returning nothing
   * completes it.
   *
   * Dispatch must be bounded: the event loop awaits each job inline, so a
   * long-running `onJob` delays every other job on this object. Detach
   * unbounded work (start it, keep durable evidence, return) instead of
   * awaiting it here; a dispatch that outlives the job's hung timeout
   * logs a warning and emits `job:slow_dispatch`.
   */
  onJob?(
    context: LifecycleJobContext
  ): MaybePromise<LifecycleJobOutcome | void>;

  /**
   * Observe one job's terminal application failure after retry exhaustion.
   * The returned outcome decides advancement; returning nothing completes
   * the job.
   */
  onJobError?(
    context: LifecycleJobContext,
    error: unknown
  ): MaybePromise<LifecycleJobOutcome | void>;

  /**
   * Apply domain policy after the alarm memory-limit circuit breaker
   * records a strike (#1825). Lifecycle has already handled the queue: the
   * executing job and every `recoveryLoop`-flagged job are backed off (or
   * purged when `sealed`). Runs at the outermost alarm frame, post-unwind,
   * best-effort — the isolate resets right after, so keep writes small.
   */
  onMemoryLimit?(context: MemoryLimitContext): MaybePromise<void>;

  /** Handle one message routed to this capability identity. */
  onRoute?(context: LifecycleRouteContext): MaybePromise<unknown>;

  /** Release live or in-memory resources during explicit host destruction. */
  dispose?(): MaybePromise<void>;
}

/**
 * Runs ordered lifecycle phases for capabilities installed in a Durable Object.
 *
 * Capabilities are resolved lazily on the first phase and retained for the
 * lifetime of this runner. Startup runs in declaration order.
 * Requests dispatch as a middleware chain: the first capability to return a
 * response handles the request.
 */
export class CapabilityRunner<Props extends object = object> {
  readonly #resolveCapabilities: () => Iterable<DurableObjectCapability<Props>>;

  #capabilities: ReadonlyArray<DurableObjectCapability<Props>> | undefined;
  #startPromise: Promise<void> | undefined;
  #started = false;

  /**
   * Create a lifecycle whose capabilities are resolved immediately before the
   * first phase.
   *
   * @param resolveCapabilities - Returns capabilities in their startup order.
   */
  constructor(
    resolveCapabilities: () => Iterable<DurableObjectCapability<Props>>
  ) {
    this.#resolveCapabilities = resolveCapabilities;
  }

  /**
   * Start every capability sequentially.
   *
   * Concurrent callers share one startup attempt. A failed attempt is not
   * cached, allowing the host to retry its complete startup phase.
   *
   * @param context - Properties supplied while resolving the Durable Object.
   */
  async start(context: CapabilityStartContext<Props>): Promise<void> {
    if (this.#started) return;

    const pending = this.#startPromise;
    if (pending) {
      await pending;
      return;
    }

    const attempt = this.#runStart(context);
    this.#startPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.#startPromise === attempt) {
        this.#startPromise = undefined;
      }
      throw error;
    }
  }

  /**
   * Offer a request to each capability middleware in registration order.
   *
   * @param context - The request entering the Durable Object.
   * @returns The first capability response, or `undefined` when no
   * capability claimed the request.
   */
  async request(
    context: CapabilityRequestContext
  ): Promise<Response | undefined> {
    await this.#ensureReady("handle a request");
    for (const capability of this.#getCapabilities()) {
      const response = await capability.onRequest?.(context);
      if (response !== undefined) return response;
    }
    return undefined;
  }

  /**
   * Offer a WebSocket upgrade to each capability in declaration order.
   *
   * @param context - The upgrade request entering the Durable Object.
   * @returns The first capability response, or `undefined` when unclaimed.
   */
  async webSocketUpgrade(
    context: CapabilityWebSocketUpgradeContext
  ): Promise<Response | undefined> {
    await this.#ensureReady("handle a WebSocket upgrade");
    for (const capability of this.#getCapabilities()) {
      const response = await capability.onWebSocketUpgrade?.(context);
      if (response !== undefined) return response;
    }
    return undefined;
  }

  /**
   * Offer a platform `webSocketMessage` wake to each capability in
   * declaration order.
   *
   * @returns Whether a capability consumed the event.
   */
  async webSocketMessage(ws: WebSocket, message: WSMessage): Promise<boolean> {
    await this.#ensureReady("handle a WebSocket message");
    for (const capability of this.#getCapabilities()) {
      if ((await capability.onWebSocketMessage?.(ws, message)) === true) {
        return true;
      }
    }
    return false;
  }

  /** Offer a platform `webSocketClose` wake to each capability. */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<boolean> {
    await this.#ensureReady("handle a WebSocket close");
    for (const capability of this.#getCapabilities()) {
      if (
        (await capability.onWebSocketClose?.(ws, code, reason, wasClean)) ===
        true
      ) {
        return true;
      }
    }
    return false;
  }

  /** Offer a platform `webSocketError` wake to each capability. */
  async webSocketError(ws: WebSocket, error: unknown): Promise<boolean> {
    await this.#ensureReady("handle a WebSocket error");
    for (const capability of this.#getCapabilities()) {
      if ((await capability.onWebSocketError?.(ws, error)) === true) {
        return true;
      }
    }
    return false;
  }

  /** Find one installed capability by its stable id. */
  async findById(
    capabilityId: string
  ): Promise<DurableObjectCapability<Props> | undefined> {
    await this.#ensureReady("dispatch capability work");
    return this.#getCapabilities().find(
      (candidate) => lifecycleCapabilityId(candidate) === capabilityId
    );
  }

  /** Route one message to an installed named capability. */
  async route(
    capabilityId: string,
    context: LifecycleRouteContext
  ): Promise<unknown> {
    await this.#ensureReady("route a capability message");
    const capability = this.#getCapabilities().find(
      (candidate) => lifecycleCapabilityId(candidate) === capabilityId
    );
    if (!capability?.onRoute) {
      throw new Error(
        `Lifecycle capability ${JSON.stringify(capabilityId)} cannot receive routed messages`
      );
    }
    return capability.onRoute(context);
  }

  /**
   * Offer a memory-limit strike to every capability, best-effort.
   *
   * Deliberately not gated on startup: a strike can land while startup
   * itself is the work that exceeded the memory limit, and the breaker's
   * policy must still reach capabilities. One capability's failure does not
   * stop the next — the isolate is about to reset either way.
   */
  async memoryLimit(context: MemoryLimitContext): Promise<void> {
    for (const capability of this.#getCapabilities()) {
      try {
        await capability.onMemoryLimit?.(context);
      } catch (error) {
        console.error("Lifecycle capability memory-limit policy failed", error);
      }
    }
  }

  /** Dispose installed capabilities in reverse registration order. */
  async dispose(): Promise<void> {
    for (const capability of [...this.#getCapabilities()].reverse()) {
      try {
        await capability.dispose?.();
      } catch (error) {
        console.error("Lifecycle capability disposal failed", error);
      }
    }
  }

  async #runStart(context: CapabilityStartContext<Props>): Promise<void> {
    for (const capability of this.#getCapabilities()) {
      await capability.onStart?.(context);
    }
    this.#started = true;
  }

  async #ensureReady(operation: string): Promise<void> {
    const pending = this.#startPromise;
    if (pending) await pending;
    if (!this.#started) {
      throw new Error(
        `Cannot ${operation} before the Durable Object lifecycle has started`
      );
    }
  }

  #getCapabilities(): ReadonlyArray<DurableObjectCapability<Props>> {
    if (!this.#capabilities) {
      this.#capabilities = Object.freeze([...this.#resolveCapabilities()]);
    }
    return this.#capabilities;
  }
}
