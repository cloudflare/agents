import { AsyncLocalStorage } from "node:async_hooks";
import { DurableObject } from "cloudflare:workers";

import { publishDiagnosticsEvent } from "../observability/diagnostics";
import {
  CapabilityRunner,
  type DurableObjectCapability,
  type LifecycleEvent,
  type LifecycleEventSink
} from "./capability-runner";
import { abortWithoutAlarmRetry } from "./abort";
import { JobDriver, type JobDeferral, type JobDispatch } from "./job-driver";
import {
  HOST_JOB_CAPABILITY,
  JobQueue,
  type LifecycleJobs,
  type LifecycleJobPushOptions
} from "./job-queue";
import {
  bindLifecycleCapability,
  lifecycleCapabilityId,
  LifecycleCapability,
  type LifecycleHostContextScope,
  type LifecycleRouteAddress,
  type LifecycleServices,
  type LifecycleStatus
} from "./capability";
import {
  runInLifecycleHostContext,
  runWithoutCurrentAgent,
  type LifecycleObject
} from "./current-agent";
import { isBenignTeardownError } from "./transport-errors";
import type { WSMessage } from "./types";

export {
  type CapabilityRequestContext,
  type CapabilityWebSocketUpgradeContext,
  type LifecycleEvent,
  type CapabilityStartContext,
  type DurableObjectCapability,
  type MemoryLimitContext
} from "./capability-runner";
export {
  type LifecycleJobContext,
  type LifecycleJobs,
  type LifecycleJob,
  type LifecycleJobOutcome,
  type LifecycleJobPushOptions
} from "./job-queue";
export * from "./types";

const LEGACY_NAME_STORAGE_KEY = "__ps_name";

/**
 * Route envelope and job owner of the facet wake. A facet has no alarm:
 * its Lifecycle asks its root to hold one job per facet path ("arm"), and
 * the root calls down to run the facet's due jobs ("drive").
 */
const FACET_WAKE = "cf:facet-wake";

/**
 * How long the root waits on a facet's drive before it lets the call run on
 * by itself: a slow job in one facet must not hold the root's own jobs and
 * the facet's siblings for the job's whole length.
 */
const FACET_DRIVE_BUDGET_MS = 5_000;
/** The root's wake for a facet whose drive outran the budget or was busy. */
const FACET_DRIVE_RECHECK_MS = 30_000;
/**
 * Drives of one facet path that may end without a reply (the isolate was
 * reset, for example by a job over the memory limit, which takes the root
 * with it) before the root backs off that path.
 */
const FACET_DRIVE_UNREPORTED_LIMIT = 3;
/** Longest back-off between drives of a path that keeps ending unreported. */
const FACET_DRIVE_MAX_BACKOFF_MS = 60 * 60_000;

type FacetDriveCount = { readonly count: number; readonly at: number };

/** The root's storage key counting one path's drives that never replied. */
function facetDriveKey(key: string): string {
  return `cf_agents:facet_drives:${key}`;
}

/** When a path whose drives keep ending unreported may be driven again. */
function facetDriveNotBefore(drives: FacetDriveCount | undefined): number {
  if (!drives || drives.count < FACET_DRIVE_UNREPORTED_LIMIT) return 0;
  const over = drives.count - FACET_DRIVE_UNREPORTED_LIMIT;
  return (
    drives.at +
    Math.min(
      FACET_DRIVE_MAX_BACKOFF_MS,
      FACET_DRIVE_RECHECK_MS * 2 ** Math.min(over, 10)
    )
  );
}

/** First wait before a facet reports its wake again after a failed report. */
const FACET_REPORT_RETRY_MS = 100;
/** Longest wait between report retries. */
const FACET_REPORT_RETRY_MAX_MS = 30_000;

type FacetWakeMessage =
  | {
      readonly type: "arm";
      readonly time: number | null;
      readonly stamp: number;
    }
  | { readonly type: "drive" };

/** A facet's drive reply: its next due time, or busy with another drive. */
type FacetDriveReply =
  | { readonly next: number | null; readonly stamp: number }
  | { readonly busy: true };

/** The root's wake job payload: the facet's address and its latest stamp. */
type FacetWakePayload = LifecycleRouteAddress & { readonly stamp?: number };

/**
 * The root's wake job for one facet path: its own owner id, so a facet that
 * keeps failing holds back only its own wake and not its siblings'.
 */
function facetWakeOwner(key: string): string {
  return `${FACET_WAKE}:${key}`;
}

function facetWakeJobId(key: string): string {
  return `facet:${key}`;
}

function mutableRequest(request: Request): Request {
  return new Request(request);
}

/**
 * Decode props from the internal lifecycle props header.
 *
 * Handles both base64-encoded lifecycle props and, for
 * backwards compatibility with stubs/requests created by older versions,
 * raw JSON. Base64 never starts with `{` or `[`, so a leading brace/bracket
 * unambiguously identifies the legacy raw-JSON form.
 */
function decodeProps(header: string): unknown {
  const trimmed = header.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  const binary = atob(header);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Internal envelope transported between routed Lifecycle instances. */
export type LifecycleRouteEnvelope = {
  readonly capability: string;
  readonly source: LifecycleRouteAddress | undefined;
  readonly payload: unknown;
};

/** Internal transport supplied by a host with routed child Lifecycles. */
export type LifecycleRouteTransport = {
  readonly source: LifecycleRouteAddress | undefined;
  readonly toRoot: (envelope: LifecycleRouteEnvelope) => Promise<unknown>;
  readonly to: (
    target: LifecycleRouteAddress,
    envelope: LifecycleRouteEnvelope
  ) => Promise<unknown>;
};

/**
 * The response to a failed `fetch` when the host's `onFetchError` gives none.
 * It never carries the error: its message and stack can reveal internals to
 * callers that are not authenticated.
 */
function defaultFetchErrorResponse(request: Request): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Internal Server Error", { status: 500 });
  }
  // Accept the socket and close it at once: browsers show a failed upgrade's
  // close code, but devtools hide the body of an HTTP error response to one.
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(1011, "Uncaught exception during session setup");
  return new Response(null, { status: 101, webSocket: pair[0] });
}

type LifecycleHost<Env extends object, Props extends object> = LifecycleObject<
  Env,
  Props
> & {
  readonly ctx: DurableObjectState;
  readonly constructor: { readonly name: string };
};

/**
 * Boundary wrapping user callbacks that capabilities run through
 * `LifecycleServices.runInHostContext`. The default boundary is
 * {@link runInLifecycleHostContext}; a host composition root may substitute
 * its own invocation wrapper (Agent adds tracing span scope). The optional
 * scope carries the live connection/request the callback runs on behalf of.
 */
export type LifecycleHostInvoker = <T>(
  run: () => T,
  scope?: LifecycleHostContextScope
) => T;

const lifecycleEventSinks = new WeakMap<object, LifecycleEventSink>();
const lifecycleRouteTransports = new WeakMap<object, LifecycleRouteTransport>();
const lifecycleHostInvokers = new WeakMap<object, LifecycleHostInvoker>();
const facetWakeForgetters = new WeakMap<
  object,
  (key: string) => Promise<void>
>();

/**
 * @internal At the root: drop the wake jobs of a facet path and every path
 * below it, when that sub-tree is deleted.
 */
export function forgetFacetWakes(
  lifecycle: object,
  key: string
): Promise<void> {
  return facetWakeForgetters.get(lifecycle)?.(key) ?? Promise.resolve();
}

/**
 * Startup tokens of the Lifecycles whose startup the current async context
 * is running inside. The scope holds opaque tokens, never a Lifecycle: every
 * promise reaction created during startup keeps this async context, and
 * workerd does not trace async context values during GC. A pending promise
 * stored on a capability would otherwise keep an evicted object alive.
 */
const lifecycleStartupScope = new AsyncLocalStorage<ReadonlySet<object>>();

/** @internal Adapt the host invocation boundary at a composition root. */
export function setLifecycleHostInvoker<
  Env extends object,
  Props extends object
>(lifecycle: Lifecycle<Env, Props>, invoker: LifecycleHostInvoker): void {
  lifecycleHostInvokers.set(lifecycle, invoker);
}

/** @internal Supply a host's routed Lifecycle transport. */
export function setLifecycleRouteTransport<
  Env extends object,
  Props extends object
>(lifecycle: Lifecycle<Env, Props>, transport: LifecycleRouteTransport): void {
  lifecycleRouteTransports.set(lifecycle, transport);
}

/** @internal Adapt Lifecycle's default diagnostics sink at a composition root. */
export function setLifecycleEventSink<Env extends object, Props extends object>(
  lifecycle: Lifecycle<Env, Props>,
  sink: LifecycleEventSink
): void {
  lifecycleEventSinks.set(lifecycle, sink);
}

/** Configuration accepted when constructing a {@link Lifecycle}. */
export type LifecycleOptions = {
  /**
   * Consecutive alarm invocations that may end in a Durable Object
   * memory-limit reset before the circuit breaker (#1825) seals recovery
   * work instead of backing it off. Default: 3.
   */
  readonly maxAlarmMemoryLimitStrikes?: number;
};

/**
 * Installs and coordinates the runtime lifecycle for a Durable Object.
 *
 * Construct this as an instance field on a class that directly extends
 * `DurableObject`, then call {@link Lifecycle.installHandlers}
 * from that class's constructor.
 */
/** The dispatch hooks a catch-all can monopolize; uniqueness is per hook. */
const CATCH_ALL_HOOKS = ["onRequest", "onWebSocketUpgrade"] as const;

export class Lifecycle<
  Env extends object = Cloudflare.Env,
  Props extends object = object
> {
  readonly #host: LifecycleHost<Env, Props>;
  readonly #ctx: DurableObjectState;
  readonly #parentClassName: string;
  readonly #capabilities: DurableObjectCapability<Props>[] = [];
  readonly #capabilityRunner = new CapabilityRunner<Props>(
    () => this.#capabilities
  );
  readonly #jobQueue: JobQueue;
  readonly #jobDriver: JobDriver;

  #status: LifecycleStatus = "zero";
  #alarmRearmQueue: Promise<void> = Promise.resolve();
  #rearmRequestedDuringStart = false;
  #pendingEvents: LifecycleEvent[] = [];
  #alarmsDisabled = false;
  #capabilitiesLocked = false;
  #handlersInstalled = false;

  /**
   * Construct and install a lifecycle in one explicit operation.
   *
   * @param host - The Durable Object whose runtime handlers the lifecycle owns.
   * @returns The installed lifecycle.
   */
  static install<Env extends object, Props extends object = object>(
    host: DurableObject<Env>,
    options?: LifecycleOptions
  ): Lifecycle<Env, Props> {
    const lifecycle = new Lifecycle<Env, Props>(host, options);
    lifecycle.installHandlers();
    return lifecycle;
  }

  /**
   * Bind a lifecycle to a Durable Object instance without mutating its handlers.
   *
   * @param host - The Durable Object whose runtime lifecycle this object owns.
   * @param options - Policy configuration for this lifecycle.
   */
  constructor(host: DurableObject<Env>, options?: LifecycleOptions) {
    // SAFETY: DurableObject exposes ctx as protected to subclasses. The
    // lifecycle is constructed by that subclass with `this`, so this boundary
    // accesses the same runtime-owned context without exposing it publicly.
    this.#host = host as unknown as LifecycleHost<Env, Props>;
    this.#ctx = this.#host.ctx;
    this.#parentClassName = this.#host.constructor.name;
    this.#jobQueue = new JobQueue(this.#ctx.storage);
    facetWakeForgetters.set(this, (key) => this.#forgetFacetWakes(key));
    this.#jobDriver = new JobDriver({
      queue: this.#jobQueue,
      storage: this.#ctx.storage,
      disabled: () => this.#alarmsDisabled,
      resolveDispatch: (owner) => this.#resolveJobDispatch(owner),
      maxMemoryLimitStrikes: () => options?.maxAlarmMemoryLimitStrikes,
      onMemoryLimit: async (context) => {
        // Capabilities first (each best-effort inside the runner), then the
        // host hook — a failed capability policy must not silence the host's.
        await this.#capabilityRunner.memoryLimit(context);
        await runInLifecycleHostContext({ host: this.#host }, () =>
          this.#host.onAlarmMemoryLimit?.(context)
        );
      },
      emit: (type, payload) =>
        this.#emitCapabilityEvent({ source: "lifecycle", type, payload }),
      rearm: (deferral) => this.#rearm(deferral),
      commitAttempt: async () => {
        if (this.#drivingFromRoot) await this.#ctx.storage.sync();
        else await new Promise((resolve) => setTimeout(resolve, 0));
      },
      armFallback: async (time) => {
        if (this.#facetAddress()) return;
        await this.#ctx.storage.setAlarm(time);
      },
      // Deferred a tick so the current invocation settles (its RPC/alarm
      // completes and its writes confirm) before the instance resets —
      // `abort()` throws an uncatchable error, mirroring Agent.destroy().
      reset: (reason) => {
        setTimeout(() => abortWithoutAlarmRetry(this.#ctx, reason), 0);
      }
    });
  }

  /**
   * Install platform fetch, alarm, and hibernating WebSocket handlers.
   *
   * Existing handlers are preserved for framework-owned dispatch such as the
   * Agent's sub-agent router and alarm circuit breaker. Calling this method
   * more than once is an error.
   */
  installHandlers(): void {
    if (this.#handlersInstalled) {
      throw new Error(
        "Durable Object lifecycle handlers are already installed"
      );
    }
    this.#handlersInstalled = true;

    const handlers = {
      fetch: this.fetch.bind(this),
      alarm: this.alarm.bind(this),
      webSocketMessage: this.webSocketMessage.bind(this),
      webSocketClose: this.webSocketClose.bind(this),
      webSocketError: this.webSocketError.bind(this)
    };
    for (const [name, handler] of Object.entries(handlers)) {
      if (name in this.#host) continue;
      Object.defineProperty(this.#host, name, {
        value: handler,
        configurable: true
      });
    }
  }

  /**
   * Add a reusable capability before this lifecycle starts.
   *
   * Capabilities dispatch in registration order, except that a capability
   * declaring `claims: "catch-all"` always comes last, whenever it was
   * installed. Catch-alls are unique per dispatch hook: two may coexist
   * when they claim disjoint traffic (one `onRequest`, one
   * `onWebSocketUpgrade`), but a second catch-all for the same hook could
   * never be reached and is refused.
   *
   * @param capability - The capability to add.
   * @returns This lifecycle.
   */
  use(capability: DurableObjectCapability<Props>): this {
    if (this.#capabilitiesLocked) {
      throw new Error("Lifecycle capabilities must be added before startup");
    }
    const capabilityId = lifecycleCapabilityId(capability);
    if (
      capabilityId &&
      this.#capabilities.some(
        (candidate) => lifecycleCapabilityId(candidate) === capabilityId
      )
    ) {
      throw new Error(
        `Lifecycle capability ${JSON.stringify(capabilityId)} is already installed`
      );
    }

    const catchAllIndex = this.#capabilities.findIndex(
      (candidate) => candidate.claims === "catch-all"
    );
    if (capability.claims === "catch-all") {
      for (const hook of CATCH_ALL_HOOKS) {
        if (!capability[hook]) continue;
        const rival = this.#capabilities.find(
          (candidate) => candidate.claims === "catch-all" && candidate[hook]
        );
        if (!rival) continue;
        const installed = lifecycleCapabilityId(rival);
        throw new Error(
          `Lifecycle already has a catch-all for ${hook}${
            installed ? ` (${JSON.stringify(installed)})` : ""
          }; a second one could never be reached`
        );
      }
      this.#capabilities.push(capability);
    } else {
      this.#capabilities.splice(
        catchAllIndex === -1 ? this.#capabilities.length : catchAllIndex,
        0,
        capability
      );
    }

    if (capability instanceof LifecycleCapability) {
      bindLifecycleCapability(
        capability,
        this.#servicesForCapability(capability.capabilityId)
      );
    }
    return this;
  }

  #servicesForCapability(capabilityId: string): LifecycleServices {
    const lifecycle = this;
    const envelope = (payload: unknown): LifecycleRouteEnvelope => ({
      capability: capabilityId,
      source: lifecycleRouteTransports.get(lifecycle)?.source,
      payload
    });
    return Object.freeze({
      get name() {
        return lifecycle.name;
      },
      className: this.#parentClassName,
      storage: this.#ctx.storage,
      sockets: Object.freeze({
        accept: (ws: WebSocket, tags: string[]) =>
          this.#ctx.acceptWebSocket(ws, tags),
        get: (tag?: string) => this.#ctx.getWebSockets(tag)
      }),
      ready: () => this.#readyForCapabilityOperation(),
      status: () => this.#status,
      jobs: this.#jobsForOwner(capabilityId),
      trackAlarmWork: (work: Promise<unknown>) =>
        this.#jobDriver.trackAlarmWork(work),
      runInHostContext: async (
        fn: () => unknown,
        scope?: LifecycleHostContextScope
      ) => this.#runInHostBoundary(fn, scope),
      events: Object.freeze({
        emit: (type: string, payload: unknown) =>
          this.#emitCapabilityEvent({ source: capabilityId, type, payload })
      }),
      routes: Object.freeze({
        get source() {
          return lifecycleRouteTransports.get(lifecycle)?.source;
        },
        toRoot: (payload: unknown) => {
          const transport = lifecycleRouteTransports.get(lifecycle);
          return transport
            ? transport.toRoot(envelope(payload))
            : this.#dispatchRoute(envelope(payload));
        },
        to: (target: LifecycleRouteAddress, payload: unknown) => {
          const transport = lifecycleRouteTransports.get(lifecycle);
          if (!transport) {
            throw new Error(
              "Lifecycle has no transport for routed capabilities"
            );
          }
          return transport.to(target, envelope(payload));
        }
      })
    });
  }

  /**
   * Run a user callback inside the host invocation boundary — plain host
   * context by default, or the composition root's substitute (Agent installs
   * its tracing invocation scope).
   */
  #runInHostBoundary(
    fn: () => unknown,
    scope?: LifecycleHostContextScope
  ): Promise<unknown> {
    const boundary = lifecycleHostInvokers.get(this);
    return Promise.resolve(
      boundary
        ? boundary(fn, scope)
        : runInLifecycleHostContext(
            {
              host: this.#host,
              connection: scope?.connection,
              request: scope?.request
            },
            fn
          )
    );
  }

  #readyForCapabilityOperation(): Promise<void> {
    return this.#ensureInitialized();
  }

  async #dispatchRoute(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    if (envelope.capability === FACET_WAKE) return this.#onFacetWake(envelope);
    await this.#ensureInitialized();
    return runWithoutCurrentAgent(() =>
      this.#capabilityRunner.route(envelope.capability, {
        source: envelope.source,
        payload: envelope.payload
      })
    );
  }

  /** @internal Deliver a generic capability envelope to this Lifecycle. */
  route(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    return this.#dispatchRoute(envelope);
  }

  /** This Lifecycle's address when it runs in a facet, else undefined. */
  #facetAddress(): LifecycleRouteAddress | undefined {
    return lifecycleRouteTransports.get(this)?.source;
  }

  /** True while the root is driving this facet's jobs. */
  #drivingFromRoot = false;
  /** The wake time this facet last gave its root. */
  #reportedWake: number | null = null;

  async #onFacetWake(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    const message = envelope.payload as FacetWakeMessage;
    if (message.type === "arm") {
      // At the root: hold, move or drop the one wake job for that facet.
      if (!envelope.source) {
        throw new Error("A facet wake needs the facet's address");
      }
      await this.#holdFacetWake(envelope.source, message.time, message.stamp);
      return true;
    }
    // One drive at a time: a root that let a slow drive run on asks again
    // later, and must not start the same jobs twice meanwhile.
    if (this.#drivingFromRoot) return { busy: true } satisfies FacetDriveReply;
    // In the facet: run its due jobs as a root's alarm would, and reply with
    // the next due time. The reply re-arms the root's job, so no report is
    // sent meanwhile; the reply is also what makes the job rows durable
    // before the root acts on it.
    this.#drivingFromRoot = true;
    this.#driveDeferral = undefined;
    try {
      await this.alarm();
    } catch (error) {
      // The driver already held or retried the failing job and re-armed;
      // the root must not treat the facet as failed for it.
      console.error(this.#errorLogPrefix("facet wake"), error);
    } finally {
      this.#drivingFromRoot = false;
    }
    // A held owner's jobs wake after their hold, as at a root.
    const next = this.#wakeTime(this.#driveDeferral);
    this.#driveDeferral = undefined;
    this.#reportedWake = next;
    return { next, stamp: this.#nextWakeStamp() } satisfies FacetDriveReply;
  }

  #lastWakeStamp = 0;

  /**
   * Order this facet's wake messages, so the root never lets an older one
   * (a drive reply that crossed a newer report) replace a newer one.
   */
  #nextWakeStamp(): number {
    this.#lastWakeStamp = Math.max(Date.now(), this.#lastWakeStamp + 1);
    return this.#lastWakeStamp;
  }

  /**
   * At the root: hold, move or drop the wake job of one facet path. A path
   * whose drives keep ending without a reply is not woken before its
   * back-off ends, however often the facet reports. A message older than
   * the one the wake already holds is ignored.
   */
  async #holdFacetWake(
    address: LifecycleRouteAddress,
    time: number | null,
    stamp: number
  ): Promise<void> {
    const jobs = this.#jobsForOwner(facetWakeOwner(address.key));
    const id = facetWakeJobId(address.key);
    const held = jobs.get(id)?.payload as FacetWakePayload | undefined;
    if ((held?.stamp ?? 0) > stamp) return;
    if (time === null) {
      await jobs.cancel(id);
      return;
    }
    const notBefore = facetDriveNotBefore(
      this.#ctx.storage.kv.get<FacetDriveCount>(facetDriveKey(address.key))
    );
    await jobs.push({
      id,
      fn: "wake",
      time: Math.max(time, notBefore),
      payload: {
        key: address.key,
        data: address.data,
        stamp
      } satisfies FacetWakePayload
    });
  }

  /**
   * At the root, on start: make every facet's wake due now (within its
   * back-off). A root that starts may have been reset with its whole tree,
   * and a facet's own start is what recovers its interrupted work, so each
   * facet with jobs is woken once instead of at its next due time. Returns
   * whether any wake moved.
   */
  #facetWakesDueNow(): boolean {
    if (!this.#jobQueue.hasJobs()) return false;
    const now = Date.now();
    const prefix = `${FACET_WAKE}:`;
    const rows = this.#ctx.storage.sql
      .exec<{ capability: string; time: number }>(
        `SELECT capability, time FROM cf_agents_jobs
         WHERE substr(capability, 1, ?) = ?`,
        prefix.length,
        prefix
      )
      .toArray();
    let moved = false;
    for (const { capability, time } of rows) {
      const path = capability.slice(prefix.length);
      // A path whose last drive never replied (perhaps the very reset that
      // restarted this root) keeps its recheck delay and back-off, even when
      // its wake is already due: nothing in this fresh isolate is driving it.
      const drives = this.#ctx.storage.kv.get<FacetDriveCount>(
        facetDriveKey(path)
      );
      const target = drives
        ? Math.max(
            now,
            drives.at + FACET_DRIVE_RECHECK_MS,
            facetDriveNotBefore(drives)
          )
        : Math.min(time, now);
      if (target === time) continue;
      this.#jobQueue.reschedule(capability, facetWakeJobId(path), target);
      moved = true;
    }
    return moved;
  }

  /**
   * At the root: drop the wake jobs of a facet path and its descendants,
   * when the sub-tree is deleted.
   */
  async #forgetFacetWakes(key: string): Promise<void> {
    if (!this.#jobQueue.hasJobs()) return;
    const owner = facetWakeOwner(key);
    const rows = this.#ctx.storage.sql
      .exec<{ capability: string }>(
        `SELECT capability FROM cf_agents_jobs
         WHERE capability = ? OR substr(capability, 1, ?) = ?`,
        owner,
        owner.length + 1,
        `${owner}/`
      )
      .toArray();
    for (const { capability } of rows) {
      const path = capability.slice(FACET_WAKE.length + 1);
      await this.#jobsForOwner(capability).cancel(facetWakeJobId(path));
      this.#ctx.storage.kv.delete(facetDriveKey(path));
    }
  }

  #emitCapabilityEvent(event: LifecycleEvent): void {
    if (event.source.trim() === "" || event.type.trim() === "") {
      throw new Error("Lifecycle events require non-empty source and type");
    }
    if (this.#status !== "started") {
      this.#pendingEvents.push(event);
      return;
    }
    this.#publishCapabilityEvent(event);
  }

  #publishCapabilityEvent(event: LifecycleEvent): void {
    runWithoutCurrentAgent(() => {
      const sink = lifecycleEventSinks.get(this);
      try {
        if (!sink) {
          publishDiagnosticsEvent({
            source: event.source,
            type: event.type,
            agent: this.#parentClassName,
            name: this.name,
            payload: event.payload,
            timestamp: Date.now()
          });
          return;
        }
        const pending = sink(event);
        if (pending !== undefined) {
          this.#ctx.waitUntil(
            Promise.resolve(pending).catch((error) => {
              this.#reportEventSinkFailure(event, error);
            })
          );
        }
      } catch (error) {
        this.#reportEventSinkFailure(event, error);
      }
    });
  }

  #reportEventSinkFailure(event: LifecycleEvent, error: unknown): void {
    console.error(
      `Lifecycle event sink failed for ${event.source}:${event.type}`,
      error
    );
  }

  #deliverPendingEvents(): void {
    for (const event of this.#pendingEvents.splice(0)) {
      this.#publishCapabilityEvent(event);
    }
  }

  /**
   * Execute SQL queries against the Durable Object's database
   * @template T Type of the returned rows
   * @param strings SQL query template strings
   * @param values Values to be inserted into the query
   * @returns Array of query results
   */
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) {
    let query = "";
    try {
      // Construct the SQL query with placeholders
      query = strings.reduce(
        (acc, str, i) => acc + str + (i < values.length ? "?" : ""),
        ""
      );

      // Execute the SQL query with the provided values
      return [...this.#ctx.storage.sql.exec(query, ...values)] as T[];
    } catch (error) {
      console.error(`failed to execute sql query: ${query}`, error);
      throw error;
    }
  }

  /**
   * Handle an incoming request for the owning Durable Object.
   *
   * Non-upgrade requests run through the capability middleware chain first,
   * then fall through to the host's `onRequest`.
   */
  async fetch(request: Request): Promise<Response> {
    try {
      const encodedProps = request.headers.get("x-agents-lifecycle-props");
      if (encodedProps) {
        this.#props = decodeProps(encodedProps) as Props;
        request = mutableRequest(request);
        request.headers.delete("x-agents-lifecycle-props");
      }

      await this.#ensureInitialized();

      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        const capabilityResponse = await runWithoutCurrentAgent(() =>
          this.#capabilityRunner.request({ request })
        );
        if (capabilityResponse !== undefined) return capabilityResponse;
        if (this.#host.onRequest) {
          return await runInLifecycleHostContext(
            { host: this.#host, request },
            () => this.#host.onRequest!(request)
          );
        }
        return new Response("Not implemented", { status: 404 });
      } else {
        // Lifecycle does not model WebSockets. A capability that owns
        // connection behavior (e.g. the WebSockets capability) claims the
        // upgrade here; without one, upgrades are not supported.
        const upgradeResponse = await runWithoutCurrentAgent(() =>
          this.#capabilityRunner.webSocketUpgrade({ request })
        );
        if (upgradeResponse !== undefined) return upgradeResponse;

        return new Response(
          "WebSocket upgrades are not enabled on this Durable Object. Install a capability that claims them (e.g. WebSockets).",
          { status: 404 }
        );
      }
    } catch (err) {
      console.error(this.#errorLogPrefix("fetch"), err);
      return this.#respondToFetchError(request, err);
    }
  }

  /** The prefix for an error logged from one of this object's handlers. */
  #errorLogPrefix(handler: string): string {
    return `Error in ${this.#parentClassName}:${this.#ctx.id.name ?? "<unnamed>"} ${handler}:`;
  }

  /**
   * Answer a failed `fetch`: the host's `onFetchError` response if it gives
   * one, otherwise a default that never carries the error.
   */
  async #respondToFetchError(
    request: Request,
    error: unknown
  ): Promise<Response> {
    if (this.#host.onFetchError) {
      try {
        const response = await runInLifecycleHostContext(
          { host: this.#host, request },
          () => this.#host.onFetchError!(request, error)
        );
        if (response instanceof Response) return response;
      } catch (hookError) {
        console.error(this.#errorLogPrefix("onFetchError"), hookError);
      }
    }
    if (!(error instanceof Error)) throw error;
    return defaultFetchErrorResponse(request);
  }

  /** @internal Dispatch a hibernating WebSocket message. */
  async webSocketMessage(ws: WebSocket, message: WSMessage): Promise<void> {
    try {
      await this.#ensureInitialized();

      // Sockets are owned by whichever capability claimed their upgrade
      // (recognized via its own hibernation attachment). Wakes for sockets
      // no capability owns — e.g. `state.acceptWebSocket()` in user code —
      // are ignored.
      await runWithoutCurrentAgent(() =>
        this.#capabilityRunner.webSocketMessage(ws, message)
      );
    } catch (e) {
      console.error(this.#errorLogPrefix("webSocketMessage"), e);
    }
  }

  /** @internal Dispatch a hibernating WebSocket close. */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    try {
      await this.#ensureInitialized();
      // The owning capability also reciprocates the close handshake, as
      // the Hibernation API contract requires.
      await runWithoutCurrentAgent(() =>
        this.#capabilityRunner.webSocketClose(ws, code, reason, wasClean)
      );
    } catch (e) {
      console.error(this.#errorLogPrefix("webSocketClose"), e);
    }
  }

  /** @internal Dispatch a hibernating WebSocket error. */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // Suppress retryable transport-teardown errors on an already closing/closed
    // socket — the connection going away during/after the close handshake, not
    // an application error. Genuine mid-connection (OPEN) errors still reach
    // the owning handler below.
    if (isBenignTeardownError(ws, error)) {
      return;
    }

    try {
      await this.#ensureInitialized();
      await runWithoutCurrentAgent(() =>
        this.#capabilityRunner.webSocketError(ws, error)
      );
    } catch (e) {
      console.error(this.#errorLogPrefix("webSocketError"), e);
    }
  }

  /**
   * Start lifecycle capabilities and the owning Durable Object.
   *
   * Runtime fetch, alarm, and WebSocket entry points call this automatically.
   * RPC methods may call it explicitly because native RPC bypasses fetch.
   *
   * Concurrent callers share one startup and all observe its outcome. A call
   * made from inside that startup, such as a capability or `onStart` calling
   * back into the host, returns immediately instead of waiting on itself.
   *
   * @param props - Optional properties supplied to capability and host startup.
   *   Ignored while a startup is already in flight.
   */
  async start(props?: Props): Promise<void> {
    if (props !== undefined && this.#startup === undefined) {
      this.#props = props;
    }
    await this.#ensureInitialized();
  }

  /**
   * Whether lifecycle startup has completed for this instance.
   *
   * @returns `true` after capabilities and the host `onStart` have finished.
   */
  isStarted(): boolean {
    return this.#status === "started";
  }

  #startup: Promise<void> | undefined;
  /** Marks this Lifecycle in {@link lifecycleStartupScope}. */
  readonly #startupToken = {};

  #ensureInitialized(): Promise<void> {
    if (this.#status === "started") return Promise.resolve();
    if (this.#startup === undefined) {
      // Deferred a tick so `#startup` is assigned before startup can call
      // back into this method synchronously.
      const startup = Promise.resolve()
        .then(() => this.#runStartup())
        .finally(() => {
          if (this.#startup === startup) this.#startup = undefined;
        });
      this.#startup = startup;
      return startup;
    }
    if (lifecycleStartupScope.getStore()?.has(this.#startupToken)) {
      return Promise.resolve();
    }
    return this.#startup;
  }

  async #runStartup(): Promise<void> {
    if (this.#ctx.id.name === undefined && this.#legacyName === undefined) {
      this.#legacyName = await this.#ctx.storage.get<string>(
        LEGACY_NAME_STORAGE_KEY
      );
    }
    // Fail before host startup if neither native nor migrated identity exists.
    void this.name;

    this.#capabilitiesLocked = true;
    const scope = new Set(lifecycleStartupScope.getStore());
    scope.add(this.#startupToken);
    let error: unknown;
    await this.#ctx.blockConcurrencyWhile(() =>
      lifecycleStartupScope.run(scope, async () => {
        this.#status = "starting";
        try {
          await runWithoutCurrentAgent(() =>
            this.#capabilityRunner.start({ props: this.#props })
          );
          await runInLifecycleHostContext({ host: this.#host }, () =>
            this.#host.onStart?.(this.#props)
          );
          this.#status = "started";
        } catch (cause) {
          this.#status = "zero";
          error = cause;
        }
      })
    );
    // Re-throw outside blockConcurrencyWhile so the input gate is not
    // permanently broken and a later invocation can retry startup.
    if (error) {
      const rearmRequested = this.#rearmRequestedDuringStart;
      this.#rearmRequestedDuringStart = false;
      this.#pendingEvents.length = 0;
      if (rearmRequested) {
        // Jobs pushed or re-timed during the failed startup deferred their
        // re-arm to here. Arm the startup fallback from the current queue so
        // they keep a wake. Best-effort: the startup error is what surfaces.
        await this.#serializeAlarmWrite(() =>
          this.#jobDriver.armStartupFallback()
        ).catch(() => {});
      }
      throw error;
    }
    this.#deliverPendingEvents();
    if (!this.#facetAddress() && this.#facetWakesDueNow()) {
      this.#rearmRequestedDuringStart = true;
    }
    if (this.#rearmRequestedDuringStart) {
      this.#rearmRequestedDuringStart = false;
      await this.rearmAlarm();
      return;
    }
    await this.#restoreLostAlarm();
  }

  /**
   * Wake check: re-arm when the queue holds jobs but no alarm is set. The
   * platform drops an alarm whose handler failed six times in a row, and
   * user code can delete it; either way pending jobs would wait for the next
   * queue mutation. An existing alarm is left alone. Best-effort: a failure
   * here must not fail the startup that woke the object.
   */
  async #restoreLostAlarm(): Promise<void> {
    if (this.#alarmsDisabled) return;
    try {
      if (!this.#jobQueue.hasJobs()) return;
      // A facet has no alarm to read: it tells its root its next wake once
      // per start, in case the root lost it.
      if (
        !this.#facetAddress() &&
        (await this.#ctx.storage.getAlarm()) !== null
      ) {
        return;
      }
      await this.rearmAlarm();
    } catch (error) {
      console.error(this.#errorLogPrefix("wake check"), error);
    }
  }

  #legacyName: string | undefined;

  /**
   * The name used to address this Durable Object.
   *
   * Native `ctx.id.name` is authoritative. A read-only legacy storage fallback
   * lets objects created by older PartyServer releases migrate without new
   * name writes.
   */
  get name(): string {
    const name = this.#ctx.id.name ?? this.#legacyName;
    if (name !== undefined) return name;
    throw new Error(
      `${this.#parentClassName} could not determine its Durable Object name. ` +
        "Address it with idFromName() or getByName(). In local development, " +
        "update Wrangler/workerd and use a current compatibility_date. " +
        "newUniqueId(), idFromString(), and names over 1,024 bytes do not " +
        "expose ctx.id.name. Alarms created before 2026-03-15 must be " +
        "rescheduled from a named fetch or RPC handler."
    );
  }

  #props?: Props;

  /**
   * The host's scoped access to the Lifecycle work queue. Items pushed here
   * are dispatched to the host's `onJob` inside the host invocation
   * boundary.
   */
  get jobs(): LifecycleJobs {
    return this.#jobsForOwner(HOST_JOB_CAPABILITY);
  }

  #jobsForOwner(owner: string): LifecycleJobs {
    const rearmAfter = async <T>(mutate: () => T): Promise<T> => {
      const result = mutate();
      await this.rearmAlarm();
      return result;
    };
    return Object.freeze({
      push: (options: LifecycleJobPushOptions) =>
        rearmAfter(() => this.#jobQueue.push(owner, options)),
      cancel: (id: string) =>
        rearmAfter(() => this.#jobQueue.cancel(owner, id)),
      reschedule: (id: string, time: number) =>
        rearmAfter(() => this.#jobQueue.reschedule(owner, id, time)),
      get: (id: string) => this.#jobQueue.get(owner, id),
      list: () => this.#jobQueue.list(owner),
      rearm: () => this.rearmAlarm()
    });
  }

  /**
   * Recompute the physical Durable Object alarm from job-queue state.
   *
   * Concurrent requests are serialized so a later durable-state change cannot
   * be overwritten by an earlier alarm calculation. The alarm is written only
   * when its time changes. Queue mutations call this automatically; it stays
   * public for composition roots and tests.
   */
  async rearmAlarm(): Promise<void> {
    return this.#rearm();
  }

  /**
   * Re-arm, optionally around a deferral: the held owners' jobs wake no
   * sooner than its end, every other job at its own time.
   */
  async #rearm(
    deferral: JobDeferral | undefined = this.#jobDriver.currentDeferral()
  ): Promise<void> {
    if (this.#alarmsDisabled) return;
    if (this.#status === "starting") {
      this.#rearmRequestedDuringStart = true;
      return;
    }

    const facet = this.#facetAddress();
    if (facet) {
      // The root's call that is driving this facet carries the next wake in
      // its reply, held back as this deferral says.
      if (this.#drivingFromRoot) {
        this.#driveDeferral = deferral;
        return;
      }
      await this.#serializeAlarmWrite(async () => {
        if (this.#alarmsDisabled) return;
        await this.#reportWakeToRoot(facet, this.#wakeTime(deferral));
      });
      return;
    }

    await this.#serializeAlarmWrite(async () => {
      if (this.#alarmsDisabled) return;
      const alarm = this.#wakeTime(deferral);
      // Each setAlarm() is billed as a row written, and most queue
      // mutations leave the earliest wake where it was.
      const current = await this.#ctx.storage.getAlarm();
      if (alarm === null) {
        if (current !== null) await this.#ctx.storage.deleteAlarm();
      } else if (current !== alarm) {
        await this.#ctx.storage.setAlarm(alarm);
      }
    });
  }

  /** The next wake: every job at its own time, held owners' after the hold. */
  #wakeTime(deferral?: JobDeferral): number | null {
    return this.#jobQueue.nextAlarmTime(Date.now(), deferral);
  }

  /** The deferral the driver ended a drive from the root with. */
  #driveDeferral: JobDeferral | undefined;

  /**
   * Tell the root this facet's next wake, when it changed. The job rows are
   * synced first: this call is not a reply, so a reset could otherwise lose
   * a row the root has already been told about.
   */
  async #reportWakeToRoot(
    facet: LifecycleRouteAddress,
    time: number | null
  ): Promise<void> {
    if (time === this.#reportedWake) return;
    const transport = lifecycleRouteTransports.get(this);
    if (!transport) return;
    try {
      await this.#ctx.storage.sync();
      await transport.toRoot({
        capability: FACET_WAKE,
        source: facet,
        payload: {
          type: "arm",
          time,
          stamp: this.#nextWakeStamp()
        } satisfies FacetWakeMessage
      });
    } catch (error) {
      // The job rows are stored; only the root does not know yet. Report
      // again shortly, backing off, so a later mutation is not the only
      // thing that would repair it (a fresh start reports too).
      this.#retryReport();
      throw error;
    }
    this.#reportRetryMs = FACET_REPORT_RETRY_MS;
    this.#reportedWake = time;
  }

  #reportRetryMs = FACET_REPORT_RETRY_MS;
  #reportRetry: ReturnType<typeof setTimeout> | undefined;

  #retryReport(): void {
    if (this.#reportRetry !== undefined) return;
    const delay = this.#reportRetryMs;
    this.#reportRetryMs = Math.min(delay * 2, FACET_REPORT_RETRY_MAX_MS);
    this.#reportRetry = setTimeout(() => {
      this.#reportRetry = undefined;
      this.rearmAlarm().catch(() => {});
    }, delay);
  }

  /**
   * Run an alarm write after every earlier one settles, so a later
   * calculation from fresher queue state always lands last.
   */
  #serializeAlarmWrite(write: () => Promise<void>): Promise<void> {
    const next = this.#alarmRearmQueue.catch(() => {}).then(write);
    this.#alarmRearmQueue = next;
    return next;
  }

  /**
   * Keep work a job handed off at a bounded return inside the current
   * alarm's memory-limit breaker domain (#1825). Hosts call this where a
   * queue-driven callback detaches long work and returns.
   *
   * @returns True when called during an alarm invocation; false otherwise.
   */
  trackAlarmWork(work: Promise<unknown>): boolean {
    return this.#jobDriver.trackAlarmWork(work);
  }

  /** Dispose installed capabilities in reverse registration order. */
  async dispose(): Promise<void> {
    await runWithoutCurrentAgent(() => this.#capabilityRunner.dispose());
  }

  /** Permanently disable and clear alarms during explicit object teardown. */
  async disableAlarms(): Promise<void> {
    this.#alarmsDisabled = true;
    await this.#alarmRearmQueue.catch(() => {});
    const facet = this.#facetAddress();
    if (!facet) {
      await this.#ctx.storage.deleteAlarm();
      return;
    }
    // A facet has no alarm; its root drops its wake job. Best-effort: a
    // facet being destroyed is also removed from the root's sub-tree.
    await this.#reportWakeToRoot(facet, null).catch(() => {});
  }

  /**
   * Run one alarm invocation. The job driver owns the event loop — deadman
   * pre-arm, due-job dispatch with retry and deferral policy, the alarm
   * memory-limit circuit breaker (#1825) — and re-arms the physical alarm
   * from queue state. The host's `onAlarm()` runs after due jobs, inside
   * the host invocation boundary.
   */
  async alarm(): Promise<void> {
    await this.#jobDriver.runAlarm(
      () => this.#ensureInitialized(),
      () =>
        runInLifecycleHostContext({ host: this.#host }, async () => {
          await this.#host.onAlarm?.();
        })
    );
  }

  /**
   * Resolve a job owner to its dispatch hooks. Host jobs run inside the
   * host invocation boundary; capability jobs run outside ambient host
   * context, like every other capability hook.
   */
  async #resolveJobDispatch(owner: string): Promise<JobDispatch | undefined> {
    if (owner.startsWith(`${FACET_WAKE}:`)) return this.#facetWakeDispatch();
    if (owner === HOST_JOB_CAPABILITY) {
      const host = this.#host;
      if (!host.onJob) return undefined;
      // No host onJobError: a host job's terminal application failure
      // completes it, and the host re-derives its jobs from durable state.
      return {
        onJob: async (context) =>
          runInLifecycleHostContext({ host }, () => host.onJob!(context))
      };
    }
    const capability = await this.#capabilityRunner.findById(owner);
    if (!capability?.onJob) return undefined;
    return {
      onJob: async (context) =>
        runWithoutCurrentAgent(() => capability.onJob!(context)),
      onJobError: capability.onJobError
        ? async (context, error) =>
            runWithoutCurrentAgent(() => capability.onJobError!(context, error))
        : undefined
    };
  }

  /**
   * At the root: a facet wake job calls down its path and runs the facet's
   * due jobs. The reply is the facet's next due time: the job moves there,
   * or completes when the facet has nothing left. A path that no longer
   * exists completes it too. A failed call goes through the driver's usual
   * failure handling, so a reset facet is retried with a fresh stub.
   */
  #facetWakeDispatch(): JobDispatch | undefined {
    const transport = lifecycleRouteTransports.get(this);
    if (!transport) return undefined;
    const kv = this.#ctx.storage.kv;
    return {
      onJob: async ({ job }) => {
        const payload = job.payload as FacetWakePayload;
        const target: LifecycleRouteAddress = {
          key: payload.key,
          data: payload.data
        };
        const countKey = facetDriveKey(target.key);
        const drives = kv.get<FacetDriveCount>(countKey);
        const notBefore = facetDriveNotBefore(drives);
        if (Date.now() < notBefore) return { rescheduleAt: notBefore };

        // Count the drive before it starts, durably: a facet job that takes
        // the isolate down (memory limit) resets this root too, so nothing
        // after the call would record it. A reply clears the count; a busy
        // reply puts the previous count back.
        const counted: FacetDriveCount = {
          count: (drives?.count ?? 0) + 1,
          at: Date.now()
        };
        kv.put(countKey, counted);
        await this.#ctx.storage.sync();

        // What the reply leaves the path's wake at. A stale path (`false`)
        // has nothing to wake; a failed call counts as unreported and is
        // retried after the back-off, never thrown into this root's driver,
        // whose failure handling belongs to the root's own jobs.
        const settle = (reply: unknown): number | null => {
          if (reply === false) {
            kv.delete(countKey);
            return null;
          }
          if ((reply as FacetDriveReply & { busy?: true }).busy) {
            if (drives) kv.put(countKey, drives);
            else kv.delete(countKey);
            return Date.now() + FACET_DRIVE_RECHECK_MS;
          }
          kv.delete(countKey);
          return (reply as { next: number | null }).next;
        };
        const failed = (error: unknown): number => {
          console.error(this.#errorLogPrefix("facet wake"), error);
          return Math.max(
            Date.now() + FACET_DRIVE_RECHECK_MS,
            facetDriveNotBefore(counted)
          );
        };
        const call = transport
          .to(target, {
            capability: FACET_WAKE,
            source: transport.source,
            payload: { type: "drive" } satisfies FacetWakeMessage
          })
          .then(
            (reply) => ({
              next: settle(reply),
              stamp: (reply as { stamp?: number } | false)
                ? ((reply as { stamp?: number }).stamp ?? 0)
                : 0
            }),
            (error: unknown) => ({ next: failed(error), stamp: 0 })
          );

        let budgetTimer: ReturnType<typeof setTimeout> | undefined;
        const budget = new Promise<"budget">((resolve) => {
          budgetTimer = setTimeout(
            () => resolve("budget"),
            FACET_DRIVE_BUDGET_MS
          );
        });
        try {
          const winner = await Promise.race([call, budget]);
          if (winner !== "budget") {
            return winner.next === null
              ? undefined
              : { rescheduleAt: winner.next };
          }
        } finally {
          clearTimeout(budgetTimer);
        }
        // The facet's drive runs on by itself; its reply moves the path's
        // wake when it comes, unless a newer report got there first.
        // Meanwhile the path keeps a recheck wake.
        this.trackAlarmWork(call);
        void call.then(({ next, stamp }) =>
          this.#holdFacetWake(target, next, stamp).catch((error: unknown) =>
            console.error(this.#errorLogPrefix("facet wake"), error)
          )
        );
        return { rescheduleAt: Date.now() + FACET_DRIVE_RECHECK_MS };
      }
    };
  }
}
