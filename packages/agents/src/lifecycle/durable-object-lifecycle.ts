import { DurableObject } from "cloudflare:workers";
import { nanoid } from "nanoid";

import { publishDiagnosticsEvent } from "../observability/diagnostics";
import {
  type AlarmContribution,
  CapabilityRunner,
  type DurableObjectCapability,
  type LifecycleEvent,
  type LifecycleEventSink
} from "./capability-runner";
import {
  bindLifecycleCapability,
  lifecycleCapabilityId,
  LifecycleCapability,
  type LifecycleRouteAddress,
  type LifecycleServices
} from "./capability";
import {
  createConnection,
  ConnectionManager,
  isManagedWebSocket
} from "./connection";

import {
  runInLifecycleHostContext,
  runWithoutCurrentAgent,
  type LifecycleObject
} from "./current-agent";
import { isBenignTeardownError } from "./transport-errors";

import type {
  Connection,
  ConnectionSetStateFn,
  ConnectionState
} from "./types";

export {
  type AlarmContribution,
  type CapabilityRequestContext,
  type LifecycleEvent,
  type CapabilityStartContext,
  type DurableObjectCapability
} from "./capability-runner";
export * from "./types";

/** Payload delivered to a lifecycle-managed WebSocket callback. */
export type WSMessage = ArrayBuffer | ArrayBufferView | string;

const LEGACY_NAME_STORAGE_KEY = "__ps_name";

/**
 * Reserved WebSocket close codes the runtime synthesizes when there
 * was no real Close frame from the peer:
 *  - 1005 (NoStatusReceived) — peer's frame had no status code.
 *  - 1006 (AbnormalClosure)  — peer dropped the underlying transport
 *                              without sending a Close frame at all.
 *  - 1015 (TLSHandshake)     — TLS failure during connection setup.
 *
 * These cannot legally appear in an outgoing Close frame, and — more
 * importantly for our reciprocation path — there is no peer left to
 * receive a reciprocating Close frame. Trying to send one anyway can
 * succeed synchronously but fail asynchronously inside the runtime
 * with "WebSocket peer disconnected" / "Network connection lost",
 * which escapes a synchronous try/catch and surfaces as an unhandled
 * promise rejection.
 */
function isReservedCloseCode(code: number): boolean {
  return code === 1005 || code === 1006 || code === 1015;
}

/**
 * Reciprocate a peer-initiated Close frame to complete the handshake.
 *
 * Best-effort: swallows synchronous errors from invalid codes,
 * oversize reasons, or sockets that have already been closed by user
 * code. Skips the reciprocation entirely when the peer didn't
 * actually send a Close frame (reserved codes 1005/1006/1015) — in
 * those cases the underlying transport is already gone and writing
 * to it would fail asynchronously, which we can't catch here.
 *
 * Used by the hibernating close handler to complete real close handshakes.
 */
function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  // No real Close frame from the peer → nothing to reciprocate.
  // Calling `ws.close(...)` here would synchronously succeed but
  // schedule an outbound write on a dead transport, which the runtime
  // would later reject with "Network connection lost". That rejection
  // can't be observed from here (it's not thrown synchronously and
  // ws.close() doesn't return a Promise to attach a `.catch` to), so
  // it would surface as an unhandled rejection.
  if (isReservedCloseCode(code)) return;
  try {
    ws.close(code, reason);
  } catch {
    // Reasons we end up here:
    //   - the socket was already closed (user called `connection.close()`
    //     in `onClose`, or the runtime auto-replied on compat dates
    //     >= 2026-04-07 for the standard `accept()` API)
    //   - `reason` exceeds the 123-byte UTF-8 limit (compat date
    //     >= 2026-03-03)
    //   - some other invariant violation we don't want to crash the
    //     handler over
    // None of these are recoverable here; the handshake is either already
    // done or the runtime is out of our control.
  }
}

function mutableRequest(request: Request): Request {
  return new Request(request);
}

function selectAlarm(
  contributions: ReadonlyArray<AlarmContribution>
): number | null {
  let ordinary: number | null = null;
  let exclusive: number | null = null;
  for (const contribution of contributions) {
    if (contribution === null) continue;
    const time =
      typeof contribution === "number" ? contribution : contribution.time;
    if (!Number.isFinite(time) || time < 0) {
      throw new Error(`Invalid alarm contribution: ${String(time)}`);
    }
    if (typeof contribution === "object" && contribution.exclusive) {
      exclusive = exclusive === null ? time : Math.min(exclusive, time);
    } else {
      ordinary = ordinary === null ? time : Math.min(ordinary, time);
    }
  }
  return exclusive ?? ordinary;
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
 * its own invocation wrapper (Agent adds tracing span scope).
 */
export type LifecycleHostInvoker = <T>(run: () => T) => T;

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
  readonly #connectionManager: ConnectionManager;

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
    this.#connectionManager = new ConnectionManager(this.#ctx);
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
      ready: () => this.#readyForCapabilityOperation(),
      starting: () => this.#status === "starting",
      alarms: Object.freeze({
        rearm: () => this.rearmAlarm(),
        disabled: () => this.#alarmsDisabled
      }),
      runInHostContext: async (fn: () => unknown) =>
        this.#runInHostBoundary(fn),
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
  #runInHostBoundary(fn: () => unknown): Promise<unknown> {
    const boundary = lifecycleHostInvokers.get(this);
    return Promise.resolve(
      boundary
        ? boundary(fn)
        : runInLifecycleHostContext({ host: this.#host }, fn)
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

      const url = new URL(request.url);

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
        // Create the websocket pair for the client
        const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
        let connectionId = url.searchParams.get("_pk");
        if (!connectionId) {
          connectionId = nanoid();
        }

        let connection: Connection = Object.assign(serverWebSocket, {
          id: connectionId,
          uri: request.url,
          tags: [] as string[],
          state: null as unknown as ConnectionState<unknown>,
          setState<T = unknown>(setState: T | ConnectionSetStateFn<T>) {
            let state: T;
            if (setState instanceof Function) {
              state = setState(this.state as ConnectionState<T>);
            } else {
              state = setState;
            }

            // TODO: deepFreeze object?
            this.state = state as ConnectionState<T>;
            return this.state;
          }
        });

        const ctx = { request };

        // getConnectionTags already receives both connection and request
        // explicitly. TODO: run it in host context if shared callback code
        // develops a concrete need for getCurrentAgent() in this hook.
        const tags = this.#host.getConnectionTags
          ? await this.#host.getConnectionTags(connection, ctx)
          : [];

        // Hibernating WebSockets remain connected while the object is evicted.
        connection = this.#connectionManager.accept(connection, { tags });
        await runInLifecycleHostContext(
          { host: this.#host, connection, request },
          () => this.#host.onConnect?.(connection, ctx)
        );

        return new Response(null, { status: 101, webSocket: clientWebSocket });
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
    // Ignore WebSockets accepted outside this lifecycle (e.g. via
    // `state.acceptWebSocket()` in user code). These sockets do not have the
    // managed attachment required to rehydrate a Connection.
    if (!isManagedWebSocket(ws)) {
      return;
    }

    try {
      const connection = createConnection(ws);

      await this.#ensureInitialized();
      return runInLifecycleHostContext({ host: this.#host, connection }, () =>
        this.#host.onMessage?.(connection, message)
      );
    } catch (e) {
      console.error(
        `Error in ${this.#parentClassName}:${this.#ctx.id.name ?? "<unnamed>"} webSocketMessage:`,
        e
      );
    }
  }

  /** @internal Dispatch and reciprocate a hibernating WebSocket close. */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    if (!isManagedWebSocket(ws)) {
      return;
    }

    try {
      const connection = createConnection(ws);

      await this.#ensureInitialized();
      await runInLifecycleHostContext({ host: this.#host, connection }, () =>
        this.#host.onClose?.(connection, code, reason, wasClean)
      );
    } catch (e) {
      console.error(
        `Error in ${this.#parentClassName}:${this.#ctx.id.name ?? "<unnamed>"} webSocketClose:`,
        e
      );
    } finally {
      // Reciprocate the peer's Close frame to complete the handshake.
      // The Hibernation API requires applications to do this — without it,
      // clients stay in CLOSING and end up reporting 1006 abnormal closure.
      // The standard `accept()` API gets this for free on compat dates
      // >= 2026-04-07 via the `web_socket_auto_reply_to_close` flag, but the
      // Hibernation API contract is unchanged: see
      // https://developers.cloudflare.com/durable-objects/api/base/#websocketclose
      // Calling close() on an already-closed socket is a silent no-op, so
      // this is safe regardless of compat date or whether user code in
      // `onClose` already called `connection.close()`.
      closeQuietly(ws, code, reason);
    }
  }

  /** @internal Dispatch a hibernating WebSocket error. */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    if (!isManagedWebSocket(ws)) {
      return;
    }

    // Suppress retryable transport-teardown errors on an already closing/closed
    // socket — the connection going away during/after the close handshake, not
    // an application error. Genuine mid-connection (OPEN) errors still reach
    // onError below.
    if (isBenignTeardownError(ws, error)) {
      return;
    }

    try {
      const connection = createConnection(ws);

      await this.#ensureInitialized();
      return runInLifecycleHostContext({ host: this.#host, connection }, () =>
        this.#host.onError?.(connection, error)
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

  #sendMessageToConnection(connection: Connection, message: WSMessage): void {
    try {
      connection.send(message);
    } catch (_e) {
      // close connection
      connection.close(1011, "Unexpected error");
    }
  }

  /** Send a message to all connected clients, except connection ids listed in `without` */
  broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[] | undefined
  ): void {
    for (const connection of this.#connectionManager.getConnections()) {
      if (!without || !without.includes(connection.id)) {
        this.#sendMessageToConnection(connection, msg);
      }
    }
  }

  /** Get a connection by connection id */
  getConnection<TState = unknown>(id: string): Connection<TState> | undefined {
    return this.#connectionManager.getConnection<TState>(id);
  }

  /** Get all managed connections, optionally filtered by tag. */
  getConnections<TState = unknown>(tag?: string): Iterable<Connection<TState>> {
    return this.#connectionManager.getConnections<TState>(tag);
  }

  #props?: Props;

  /**
   * Recompute the physical Durable Object alarm from every capability.
   *
   * Concurrent requests are serialized so a later durable-state change cannot
   * be overwritten by an earlier alarm calculation.
   */
  async rearmAlarm(): Promise<void> {
    if (this.#alarmsDisabled) return;
    if (this.#status === "starting") {
      this.#rearmRequestedDuringStart = true;
      return;
    }
    if (this.#status === "zero") await this.start();

    const prior = this.#alarmRearmQueue;
    const next = prior
      .catch(() => {})
      .then(async () => {
        if (this.#alarmsDisabled) return;
        const contributions = await runWithoutCurrentAgent(() =>
          this.#capabilityRunner.getAlarmContributions()
        );
        const hostContribution = await runInLifecycleHostContext(
          { host: this.#host },
          () => this.#host.getNextAlarm?.()
        );
        if (hostContribution !== undefined) {
          contributions.push(hostContribution);
        }
        const alarm = selectAlarm(contributions);
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

  /** Dispatch lifecycle and host alarm callbacks after startup. */
  async alarm(): Promise<void> {
    await this.#ensureInitialized();
    await runWithoutCurrentAgent(() => this.#capabilityRunner.alarm());
    await runInLifecycleHostContext({ host: this.#host }, () =>
      this.#host.onAlarm?.()
    );
    await this.rearmAlarm();
  }
}
