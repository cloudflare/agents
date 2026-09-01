import { DurableObject } from "cloudflare:workers";

import { publishDiagnosticsEvent } from "../observability/diagnostics";
import {
  CapabilityRunner,
  type DurableObjectCapability,
  type LifecycleEvent,
  type LifecycleEventSink
} from "./capability-runner";
import { abortWithoutAlarmRetry } from "./abort";
import { JobDriver, type JobDispatch } from "./job-driver";
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
  type LifecycleServices
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

type LifecycleHost<
  Env extends object,
  Props extends Record<string, unknown>
> = LifecycleObject<Env, Props> & {
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

/** @internal Adapt the host invocation boundary at a composition root. */
export function setLifecycleHostInvoker<
  Env extends object,
  Props extends Record<string, unknown>
>(lifecycle: Lifecycle<Env, Props>, invoker: LifecycleHostInvoker): void {
  lifecycleHostInvokers.set(lifecycle, invoker);
}

/** @internal Supply a host's routed Lifecycle transport. */
export function setLifecycleRouteTransport<
  Env extends object,
  Props extends Record<string, unknown>
>(lifecycle: Lifecycle<Env, Props>, transport: LifecycleRouteTransport): void {
  lifecycleRouteTransports.set(lifecycle, transport);
}

/** @internal Adapt Lifecycle's default diagnostics sink at a composition root. */
export function setLifecycleEventSink<
  Env extends object,
  Props extends Record<string, unknown>
>(lifecycle: Lifecycle<Env, Props>, sink: LifecycleEventSink): void {
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
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Lifecycle<
  Env extends object = Cloudflare.Env,
  Props extends Record<string, unknown> = Record<string, unknown>
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

  #status: "zero" | "starting" | "started" = "zero";
  #alarmRearmQueue: Promise<void> = Promise.resolve();
  #rearmRequestedDuringStart = false;
  #drivingAlarm = false;
  #rearmRequestedDuringAlarm = false;
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
  static install<
    Env extends object,
    Props extends Record<string, unknown> = Record<string, unknown>
  >(
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
      rearm: () => this.rearmAlarm(),
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
   * @param capability - The capability to add in dispatch order.
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
    this.#capabilities.push(capability);
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
      storage: this.#ctx.storage,
      sockets: Object.freeze({
        accept: (ws: WebSocket, tags: string[]) =>
          this.#ctx.acceptWebSocket(ws, tags),
        get: (tag?: string) => this.#ctx.getWebSockets(tag)
      }),
      ready: () => this.#readyForCapabilityOperation(),
      starting: () => this.#status === "starting",
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

  async #readyForCapabilityOperation(): Promise<void> {
    if (this.#status === "starting" || this.#status === "started") return;
    await this.start();
  }

  async #dispatchRoute(envelope: LifecycleRouteEnvelope): Promise<unknown> {
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
      console.error(
        `Error in ${this.#parentClassName}:${this.#ctx.id.name ?? "<unnamed>"} fetch:`,
        err
      );
      if (!(err instanceof Error)) throw err;
      if (request.headers.get("Upgrade") === "websocket") {
        // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
        // won't show us the response body! So... let's send a WebSocket response with an error
        // frame instead.
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].send(JSON.stringify({ error: err.stack }));
        pair[1].close(1011, "Uncaught exception during session setup");
        return new Response(null, { status: 101, webSocket: pair[0] });
      } else {
        return new Response(err.stack, { status: 500 });
      }
    }
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
      console.error(
        `Error in ${this.#parentClassName}:${this.#ctx.id.name ?? "<unnamed>"} webSocketMessage:`,
        e
      );
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
      console.error(
        `Error in ${this.#parentClassName}:${this.#ctx.id.name ?? "<unnamed>"} webSocketClose:`,
        e
      );
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
      console.error(
        `Error in ${this.#parentClassName}:${this.#ctx.id.name ?? "<unnamed>"} webSocketError:`,
        e
      );
    }
  }

  /**
   * Start lifecycle capabilities and the owning Durable Object.
   *
   * Runtime fetch, alarm, and WebSocket entry points call this automatically.
   * RPC methods may call it explicitly because native RPC bypasses fetch.
   *
   * @param props - Optional properties supplied to capability and host startup.
   */
  async start(props?: Props): Promise<void> {
    if (props !== undefined) this.#props = props;
    await this.#ensureInitialized();
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#status === "started") return;

    if (this.#ctx.id.name === undefined && this.#legacyName === undefined) {
      this.#legacyName = await this.#ctx.storage.get<string>(
        LEGACY_NAME_STORAGE_KEY
      );
    }
    // Fail before host startup if neither native nor migrated identity exists.
    void this.name;

    this.#capabilitiesLocked = true;
    let error: unknown;
    await this.#ctx.blockConcurrencyWhile(async () => {
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
    });
    // Re-throw outside blockConcurrencyWhile so the input gate is not
    // permanently broken and a later invocation can retry startup.
    if (error) {
      this.#rearmRequestedDuringStart = false;
      this.#pendingEvents.length = 0;
      throw error;
    }
    this.#deliverPendingEvents();
    if (this.#rearmRequestedDuringStart) {
      this.#rearmRequestedDuringStart = false;
      await this.rearmAlarm();
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
   * be overwritten by an earlier alarm calculation. Queue mutations call this
   * automatically; it stays public for composition roots and tests.
   */
  async rearmAlarm(): Promise<void> {
    if (this.#alarmsDisabled) return;
    if (this.#status === "starting") {
      this.#rearmRequestedDuringStart = true;
      return;
    }
    if (this.#drivingAlarm) {
      // Keep JobDriver's deadman alarm armed while the bounded due batch and
      // its tracked work settle. The final queue state is applied once.
      this.#rearmRequestedDuringAlarm = true;
      return;
    }

    const prior = this.#alarmRearmQueue;
    const next = prior
      .catch(() => {})
      .then(async () => {
        if (this.#alarmsDisabled) return;
        const alarm = this.#jobQueue.nextAlarmTime(Date.now());
        if (alarm === null) {
          await this.#ctx.storage.deleteAlarm();
        } else {
          await this.#ctx.storage.setAlarm(alarm);
        }
      });
    this.#alarmRearmQueue = next;
    await next;
  }

  /**
   * Keep work started by the current alarm inside its memory-limit breaker
   * boundary after a bounded job callback returns.
   *
   * @returns True when called during job dispatch; false outside an alarm.
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
    await this.#ctx.storage.deleteAlarm();
  }

  /**
   * Run one alarm invocation. The job driver owns the event loop — deadman
   * pre-arm, due-job dispatch with retry and deferral policy, the alarm
   * memory-limit circuit breaker (#1825) — and re-arms the physical alarm
   * from queue state. The host's `onAlarm()` runs after due jobs, inside
   * the host invocation boundary.
   */
  async alarm(): Promise<void> {
    this.#drivingAlarm = true;
    try {
      await this.#jobDriver.runAlarm(
        () => this.#ensureInitialized(),
        () =>
          runInLifecycleHostContext({ host: this.#host }, async () => {
            await this.#host.onAlarm?.();
          })
      );
    } finally {
      this.#drivingAlarm = false;
      if (this.#rearmRequestedDuringAlarm) {
        this.#rearmRequestedDuringAlarm = false;
        await this.rearmAlarm();
      }
    }
  }

  /**
   * Resolve a job owner to its dispatch hooks. Host jobs run inside the
   * host invocation boundary; capability jobs run outside ambient host
   * context, like every other capability hook.
   */
  async #resolveJobDispatch(owner: string): Promise<JobDispatch | undefined> {
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
}
