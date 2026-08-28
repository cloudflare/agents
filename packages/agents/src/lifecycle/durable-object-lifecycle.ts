import { DurableObject } from "cloudflare:workers";

import { publishDiagnosticsEvent } from "../observability/diagnostics";
import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isPlatformTransientError,
  tryN
} from "../retries";
import {
  CapabilityRunner,
  type DurableObjectCapability,
  type LifecycleEvent,
  type LifecycleEventSink
} from "./capability-runner";
import {
  HOST_JOB_CAPABILITY,
  isHungRow,
  JobQueue,
  type LifecycleJobContext,
  type LifecycleJobs,
  type LifecycleJob,
  type LifecycleJobOutcome,
  type LifecycleJobPushOptions,
  type JobStorageRow
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
  type DurableObjectCapability
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

/** Default consecutive memory-limit strikes tolerated before sealing. */
const DEFAULT_MAX_ALARM_MEMORY_LIMIT_STRIKES = 3;

/** Durable storage key for the alarm memory-limit strike counter (#1825). */
const OOM_ALARM_STRIKES_KEY = "cf_agents:oom_alarm_strikes";

/** Default retry policy applied to jobs pushed without one. */
const DEFAULT_JOB_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 3000
} as const;

/** Due jobs for one capability above this count log a backlog warning. */
const JOB_BACKLOG_WARNING_THRESHOLD = 10;

/**
 * Deadman pre-arm delay: armed before the event loop drives due jobs so an
 * isolate death mid-drive still wakes this object to resume its queue.
 */
const DEADMAN_ALARM_DELAY_MS = 30_000;

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

const lifecycleMemoryLimitStrikeBudgets = new WeakMap<object, number>();

/**
 * @internal Set the consecutive alarm memory-limit strikes tolerated before
 * the Lifecycle circuit breaker seals recovery work (#1825). Composition
 * roots (Agent) supply their configured budget; the default is 3.
 */
export function setLifecycleAlarmMemoryLimitStrikes<
  Env extends object,
  Props extends Record<string, unknown>
>(lifecycle: Lifecycle<Env, Props>, maxStrikes: number): void {
  lifecycleMemoryLimitStrikeBudgets.set(lifecycle, maxStrikes);
}

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
  #executingJobRow: JobStorageRow | undefined;

  #status: "zero" | "starting" | "started" = "zero";
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
  static install<
    Env extends object,
    Props extends Record<string, unknown> = Record<string, unknown>
  >(host: DurableObject<Env>): Lifecycle<Env, Props> {
    const lifecycle = new Lifecycle<Env, Props>(host);
    lifecycle.installHandlers();
    return lifecycle;
  }

  /**
   * Bind a lifecycle to a Durable Object instance without mutating its handlers.
   *
   * @param host - The Durable Object whose runtime lifecycle this object owns.
   */
  constructor(host: DurableObject<Env>) {
    // SAFETY: DurableObject exposes ctx as protected to subclasses. The
    // lifecycle is constructed by that subclass with `this`, so this boundary
    // accesses the same runtime-owned context without exposing it publicly.
    this.#host = host as unknown as LifecycleHost<Env, Props>;
    this.#ctx = this.#host.ctx;
    this.#parentClassName = this.#host.constructor.name;
    this.#jobQueue = new JobQueue(this.#ctx.storage);
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
   * Run the alarm event loop: execute due work items, run the host's
   * `onAlarm()`, and re-arm the physical alarm from queue state.
   *
   * The loop runs inside the alarm memory-limit circuit breaker (#1825): a
   * memory-limit reset that propagates here is intercepted — every other
   * error re-throws unchanged so platform alarm retry semantics hold — and
   * broken from this outermost frame, where the heavy turn has unwound and
   * small writes can land. A durable strike counter tolerates a few
   * consecutive resets with backoff, then seals: the executing item is
   * purged and the host's `onAlarmMemoryLimit()` applies domain policy.
   */
  async alarm(): Promise<void> {
    await this.#ensureInitialized();
    try {
      await this.#driveDueJobs();
      await runInLifecycleHostContext({ host: this.#host }, () =>
        this.#host.onAlarm?.()
      );
      await this.#clearMemoryLimitStrikes();
    } catch (error) {
      if (!isDurableObjectMemoryLimitReset(error)) throw error;
      await this.#handleMemoryLimitReset(error);
      return;
    }
    await this.rearmAlarm();
  }

  /** Drive every due job once, in due-time order. */
  async #driveDueJobs(): Promise<void> {
    const nowMs = Date.now();
    const due = this.#jobQueue.due(nowMs);
    if (due.length === 0) return;
    this.#warnJobBacklog(due);

    // Deadman pre-arm: before driving any job, arm a fallback alarm so a
    // death mid-drive that the platform cannot retry (or that swallows its
    // error) still wakes this object to resume. The normal re-arm at the end
    // of the alarm phase overwrites it.
    if (!this.#alarmsDisabled) {
      await this.#ctx.storage.setAlarm(nowMs + DEADMAN_ALARM_DELAY_MS);
    }

    for (const row of due) {
      // Host teardown mid-phase: its storage is gone, stop touching it.
      if (this.#alarmsDisabled) return;

      if (row.singleflight === 1 && row.running === 1) {
        if (!isHungRow(row, nowMs)) {
          console.warn(
            `Skipping job ${row.id}: previous execution still running`
          );
          continue;
        }
        console.warn(
          `Forcing reset of hung job ${row.id} (started ${Math.round(
            (nowMs - (row.execution_started_at ?? 0)) / 1000
          )}s ago)`
        );
      }
      if (row.singleflight === 1) {
        this.#jobQueue.markRunning(row.id, nowMs);
      }

      await this.#driveJob(row);
    }
  }

  /** Dispatch one due row to its owner with retry and failure policy. */
  async #driveJob(row: JobStorageRow): Promise<void> {
    const job = this.#jobFromRow(row);
    const dispatch = await this.#resolveJobDispatch(row.capability);
    if (!dispatch) {
      console.error(
        `No installed capability or host handler for job ${row.id} ` +
          `(owner ${JSON.stringify(row.capability)}); dropping it`
      );
      this.#jobQueue.delete(row.id);
      return;
    }

    const retry = job.retry;
    const maxAttempts = retry?.maxAttempts ?? DEFAULT_JOB_RETRY.maxAttempts;
    const baseDelayMs = retry?.baseDelayMs ?? DEFAULT_JOB_RETRY.baseDelayMs;
    const maxDelayMs = retry?.maxDelayMs ?? DEFAULT_JOB_RETRY.maxDelayMs;

    this.#executingJobRow = row;
    try {
      const outcome = await tryN(
        maxAttempts,
        async (attempt) =>
          (await dispatch.onJob({ job, attempt })) as
            | LifecycleJobOutcome
            | undefined,
        {
          baseDelayMs,
          maxDelayMs,
          // In-process retries are futile on a superseded isolate: code
          // never reloads mid-invocation. Defer to a fresh invocation.
          shouldRetry: (error) => !isDurableObjectCodeUpdateReset(error)
        }
      );
      if (this.#alarmsDisabled) return;
      this.#jobQueue.applyOutcome(row.id, outcome ?? undefined);
      this.#executingJobRow = undefined;
    } catch (error) {
      if (this.#alarmsDisabled) return;
      if (
        isDurableObjectMemoryLimitReset(error) ||
        isDurableObjectCodeUpdateReset(error) ||
        isPlatformTransientError(error)
      ) {
        // Platform-class failure: preserve the job and re-throw so the
        // platform retries a fresh invocation (or the memory-limit breaker
        // engages at the alarm boundary). Best-effort running reset so a
        // single-flight job does not wait out its hung timeout first.
        try {
          if (row.singleflight === 1) this.#jobQueue.clearRunning(row.id);
        } catch {
          // the hung timeout eventually recovers the flag
        }
        console.warn(
          `Deferring job ${row.id} to a fresh invocation after a ` +
            `platform failure; the job is preserved.`
        );
        // Leave #executingJobRow set: the memory-limit breaker at the alarm
        // boundary targets the exact job that was executing.
        throw error;
      }
      // Application failure after retry exhaustion: the owner observes it
      // and decides advancement; default is completion.
      let outcome: LifecycleJobOutcome | void;
      try {
        outcome = (await dispatch.onJobError?.(
          { job, attempt: maxAttempts },
          error
        )) as LifecycleJobOutcome | void;
      } catch (hookError) {
        console.error(`Job failure hook threw for ${row.id}`, hookError);
      }
      if (this.#alarmsDisabled) return;
      this.#jobQueue.applyOutcome(row.id, outcome ?? undefined);
      this.#executingJobRow = undefined;
    }
  }

  #jobFromRow(row: JobStorageRow): LifecycleJob {
    return {
      id: row.id,
      capability: row.capability,
      fn: row.fn,
      time: row.time,
      payload:
        typeof row.payload === "string" ? JSON.parse(row.payload) : undefined,
      retry:
        typeof row.retry_options === "string"
          ? JSON.parse(row.retry_options)
          : undefined,
      singleflight: row.singleflight === 1,
      exclusive: row.exclusive === 1,
      createdAt: row.created_at
    };
  }

  /** Resolve a job owner to its dispatch hooks. */
  async #resolveJobDispatch(owner: string): Promise<
    | {
        onJob: (context: LifecycleJobContext) => unknown | Promise<unknown>;
        onJobError?: (
          context: LifecycleJobContext,
          error: unknown
        ) => unknown | Promise<unknown>;
      }
    | undefined
  > {
    if (owner === HOST_JOB_CAPABILITY) {
      const host = this.#host;
      if (!host.onJob) return undefined;
      return {
        onJob: (context) =>
          runInLifecycleHostContext({ host }, () => host.onJob!(context)),
        onJobError: host.onJobError
          ? (context, error) =>
              runInLifecycleHostContext({ host }, () =>
                host.onJobError!(context, error)
              )
          : undefined
      };
    }
    const capability = await this.#capabilityRunner.findById(owner);
    if (!capability?.onJob) return undefined;
    return {
      onJob: (context) =>
        runWithoutCurrentAgent(() => capability.onJob!(context)),
      onJobError: capability.onJobError
        ? (context, error) =>
            runWithoutCurrentAgent(() => capability.onJobError!(context, error))
        : undefined
    };
  }

  #warnJobBacklog(due: ReadonlyArray<JobStorageRow>): void {
    const counts = new Map<string, number>();
    for (const row of due) {
      counts.set(row.capability, (counts.get(row.capability) ?? 0) + 1);
    }
    for (const [owner, count] of counts) {
      if (count < JOB_BACKLOG_WARNING_THRESHOLD) continue;
      try {
        console.warn(
          `Processing ${count} due jobs for ${JSON.stringify(owner)} ` +
            `in a single alarm cycle. This usually means one-shot jobs are ` +
            `pushed repeatedly without a stable id.`
        );
        this.#emitCapabilityEvent({
          source: "lifecycle",
          type: "job:backlog_warning",
          payload: { capability: owner, count }
        });
      } catch {
        // warning emission never blocks work processing
      }
    }
  }

  /**
   * Clear the durable memory-limit strike counter after a clean alarm so the
   * breaker counts CONSECUTIVE resets rather than lifetime ones (#1825).
   * Reads first and only writes when a strike is recorded. Best-effort.
   */
  async #clearMemoryLimitStrikes(): Promise<void> {
    try {
      const prior = await this.#ctx.storage.get<number>(OOM_ALARM_STRIKES_KEY);
      if (typeof prior === "number" && prior > 0) {
        await this.#ctx.storage.delete(OOM_ALARM_STRIKES_KEY);
      }
    } catch {
      // a stale strike only costs one extra tolerated spike later
    }
  }

  /**
   * Alarm-boundary circuit breaker for Durable Object memory-limit resets
   * (#1825). Unhandled, the platform would auto-retry the alarm forever,
   * re-running the doomed work each cycle. A durable strike counter
   * tolerates a few consecutive resets — backing off the executing item so
   * the retry is not a hot loop — then seals: the executing item is purged
   * and the host's `onAlarmMemoryLimit()` hook applies domain policy. Each
   * step is best-effort: even these small writes can OOM, but swallowing
   * still halts the platform's auto-retry, and a later wake re-arms
   * legitimate work.
   */
  async #handleMemoryLimitReset(error: unknown): Promise<void> {
    const executing = this.#executingJobRow;
    this.#executingJobRow = undefined;

    let strikes = 1;
    try {
      const prior = await this.#ctx.storage.get<number>(OOM_ALARM_STRIKES_KEY);
      strikes = (typeof prior === "number" ? prior : 0) + 1;
      await this.#ctx.storage.put(OOM_ALARM_STRIKES_KEY, strikes);
    } catch {
      // even the strike write OOMed; still progress toward sealing
    }

    const limit =
      lifecycleMemoryLimitStrikeBudgets.get(this) ??
      DEFAULT_MAX_ALARM_MEMORY_LIMIT_STRIKES;
    const sealed = strikes >= limit;
    console.error(
      `Alarm hit a Durable Object memory-limit reset (strike ${strikes}/${limit}` +
        `${sealed ? ", sealing recovery" : ", will retry with backoff"}). ` +
        "Breaking the platform alarm-retry loop (#1825).",
      error instanceof Error ? error.message : String(error)
    );

    const nextTime = sealed
      ? undefined
      : Date.now() + Math.min(300, 30 * strikes) * 1000;

    try {
      if (executing) {
        if (sealed) {
          this.#jobQueue.delete(executing.id);
        } else if (nextTime !== undefined) {
          this.#jobQueue.applyOutcome(executing.id, {
            rescheduleAt: nextTime
          });
        }
      }
    } catch {
      // best-effort at a failure boundary
    }

    try {
      await runInLifecycleHostContext({ host: this.#host }, () =>
        this.#host.onAlarmMemoryLimit?.({ sealed, nextTime })
      );
    } catch {
      // best-effort domain policy; the purge above already broke the loop
    }

    if (sealed) {
      try {
        await this.#ctx.storage.delete(OOM_ALARM_STRIKES_KEY);
      } catch {
        // best-effort counter reset
      }
    }

    try {
      this.#emitCapabilityEvent({
        source: "lifecycle",
        type: "alarm:memory_limit_reset",
        payload: {
          strikes,
          limit,
          sealed,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    } catch {
      // event emission is non-critical
    }

    // Re-arm so unrelated work continues. Wrapped because it can itself OOM;
    // if it does, the next external wake re-arms.
    try {
      await this.rearmAlarm();
    } catch {
      // best-effort
    }
  }
}
