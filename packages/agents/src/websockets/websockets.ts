import { RpcTarget } from "cloudflare:workers";
import { nanoid } from "nanoid";
import {
  LifecycleCapability,
  type CapabilityWebSocketUpgradeContext,
  type Connection,
  type ConnectionContext,
  type ConnectionSetStateFn,
  type ConnectionState
} from "../lifecycle";
import type { State } from "../state";
import { MessageType } from "../types";
import { camelCaseToKebabCase } from "../utils";
import {
  ConnectionManager,
  createConnection,
  isManagedWebSocket
} from "./connection";
import { exposableMethods, type CallableInvoker } from "./callables-target";
import type {
  WebSocketHandlers,
  WebSocketMessage,
  WebSocketsOptions
} from "./options";
import { openCapnWebSession, type CapnWebSession } from "./transport";
import { isCapnWebTransportUpgrade } from "./transport-protocol";

/**
 * Reserved close codes the runtime synthesizes when there was no real
 * Close frame from the peer (1005 NoStatusReceived, 1006 AbnormalClosure,
 * 1015 TLSHandshake). They cannot appear in an outgoing Close frame, and
 * there is no peer left to receive a reciprocation.
 */
function isReservedCloseCode(code: number): boolean {
  return code === 1005 || code === 1006 || code === 1015;
}

/**
 * Reciprocate a peer-initiated Close frame to complete the handshake, as
 * the Hibernation API contract requires. Best-effort: swallows errors
 * from already-closed sockets or invalid codes/reasons, and skips
 * reciprocation entirely for reserved codes (dead transport).
 */
function reciprocateClose(ws: WebSocket, code: number, reason: string): void {
  if (isReservedCloseCode(code)) return;
  try {
    ws.close(code, reason);
  } catch {
    // Already closed, oversize reason, or another unrecoverable
    // invariant — the handshake is either done or out of our control.
  }
}

/** The `rpc` request frame `useAgent().call` and `AgentClient.call` send. */
type RpcRequest = {
  readonly type: "rpc";
  readonly id: string;
  readonly method: string;
  readonly args: unknown[];
};

type RpcResponse =
  | { type: "rpc"; id: string; success: true; done: boolean; result: unknown }
  | { type: "rpc"; id: string; success: false; error: string };

/** The `cf_agent_state` frame a client sends to update host state. */
type StateFrame = { readonly type: "cf_agent_state"; readonly state: unknown };

function isStateFrame(value: unknown): value is StateFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  return frame.type === MessageType.CF_AGENT_STATE && "state" in frame;
}

function isRpcRequest(value: unknown): value is RpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === MessageType.RPC &&
    typeof frame.id === "string" &&
    typeof frame.method === "string" &&
    Array.isArray(frame.args)
  );
}

/**
 * Opt-in WebSocket support for Lifecycle Objects.
 *
 * Lifecycle itself does not model WebSockets — hosts that want them
 * install this capability, which owns the connection subsystem end to
 * end: it claims upgrades, dispatches `onConnect`/`onMessage`/`onClose`
 * inside the host invocation boundary, reciprocates close handshakes,
 * and answers `getConnections()`/`getConnection()`.
 *
 * ```ts
 * class Room extends DurableObject<Env> {
 *   readonly webSockets = new WebSockets({
 *     handlers: {
 *       onConnect: (connection) => connection.send("welcome"),
 *       onMessage: (connection, message) => { ... }
 *     },
 *     callables: new RoomCallables()
 *   });
 *   readonly lifecycle = Lifecycle.install(this).use(this.webSockets);
 * }
 * ```
 *
 * Connections arrive on one of two wires, chosen by the client:
 *
 * - **cf-websocket** (default): accepted with the Hibernation API. Idle
 *   clients stay connected while the Durable Object leaves memory.
 * - **capnweb** (`?__agents_transport=capnweb`): protocol frames through
 *   one pipe method on a Cap'n Web session whose root also carries the
 *   host's callables natively. Non-hibernating — the object stays pinned
 *   while the connection is open.
 *
 * Both wires dispatch the same handlers and appear in `getConnections()`.
 * On both, the capability speaks the Agent protocol a plain host needs
 * for `useAgent` and `AgentClient`: it sends the identity frame on
 * connect, and it serves `callables` — as `rpc` JSON frames on the
 * WebSocket wire, and natively on the Cap'n Web session root, where an
 * `RpcTarget` result becomes a live stub and calls pipeline. `call()`
 * and `stub` work against a plain Durable Object exactly as against an
 * `Agent`. Pass a `State` capability as `state` and the hook's
 * `state`/`setState` work too: the current value is pushed on connect,
 * client updates are validated and applied, and changes broadcast.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class WebSockets extends LifecycleCapability {
  /** Claims every upgrade, so Lifecycle dispatches it after all others. */
  override readonly claims = "catch-all";

  readonly #handlers: WebSocketHandlers | undefined;
  readonly #getConnectionTags: WebSocketsOptions["getConnectionTags"];
  readonly #identity: boolean;
  readonly #state: State<unknown> | undefined;
  readonly #callables: ReadonlyMap<string, CallableInvoker>;
  readonly #sessions = new Map<string, CapnWebSession>();
  #manager: ConnectionManager | undefined;

  constructor(options: WebSocketsOptions = {}) {
    super("websockets");
    this.#handlers = options.handlers;
    this.#getConnectionTags = options.getConnectionTags;
    this.#identity = options.identity ?? true;
    this.#state = options.state;
    this.#callables = options.callables
      ? exposableMethods(options.callables)
      : new Map();
  }

  // ── Lifecycle capability hooks ─────────────────────────────────────────

  /**
   * Claim every upgrade, never declining: a Cap'n Web transport upgrade
   * becomes a session, everything else a tracked hibernating connection,
   * whether or not handlers or callables are configured. Handlers only add
   * behavior on connect, message, close, and error.
   */
  onWebSocketUpgrade({
    request
  }: CapabilityWebSocketUpgradeContext): Promise<Response> {
    return isCapnWebTransportUpgrade(request)
      ? this.#acceptCapnWebSession(request)
      : this.#acceptConnection(request);
  }

  /** Dispatch a platform message wake for a capability-owned socket. */
  async onWebSocketMessage(
    ws: WebSocket,
    message: WebSocketMessage
  ): Promise<boolean> {
    if (!isManagedWebSocket(ws)) return false;
    await this.#message(createConnection(ws), message);
    return true;
  }

  /** Dispatch and reciprocate a close wake for an owned socket. */
  async onWebSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<boolean> {
    if (!isManagedWebSocket(ws)) return false;
    try {
      await this.#close(createConnection(ws), code, reason, wasClean);
    } finally {
      reciprocateClose(ws, code, reason);
    }
    return true;
  }

  /** Dispatch an error wake for an owned socket. */
  async onWebSocketError(ws: WebSocket, error: unknown): Promise<boolean> {
    if (!isManagedWebSocket(ws)) return false;
    await this.#error(createConnection(ws), error);
    return true;
  }

  /**
   * Close every owned connection during explicit host destruction. The
   * capability owns its sockets' lifetimes, so it also owns tearing
   * them down.
   */
  dispose(): void {
    for (const connection of this.getConnections()) {
      try {
        connection.close(1001, "Durable Object destroyed");
      } catch {
        // Already closed or mid-handshake — nothing left to tear down.
      }
    }
  }

  // ── Connections ────────────────────────────────────────────────────────

  /** Open connections on either wire, optionally by tag. */
  *getConnections<TState = unknown>(
    tag?: string
  ): IterableIterator<Connection<TState>> {
    for (const { connection } of this.#sessions.values()) {
      if (connection.readyState !== WebSocket.OPEN) continue;
      if (!tag || connection.tags.includes(tag)) {
        yield connection as Connection<TState>;
      }
    }
    yield* this.#connectionManager.getConnections<TState>(tag);
  }

  /** One connection on either wire, by id. */
  getConnection<TState = unknown>(id: string): Connection<TState> | undefined {
    const session = this.#sessions.get(id)?.connection;
    if (session && session.readyState === WebSocket.OPEN) {
      return session as Connection<TState>;
    }
    return this.#connectionManager.getConnection<TState>(id);
  }

  get #connectionManager(): ConnectionManager {
    this.#manager ??= new ConnectionManager(this.lifecycle.sockets);
    return this.#manager;
  }

  // ── Wire-independent protocol ──────────────────────────────────────────

  async #connect(
    connection: Connection,
    ctx: ConnectionContext
  ): Promise<void> {
    if (this.#identity) {
      this.#sendFrame(connection, {
        type: MessageType.CF_AGENT_IDENTITY,
        name: this.lifecycle.name,
        agent: camelCaseToKebabCase(this.lifecycle.className)
      });
    }
    if (this.#state) {
      // After identity, so a client that resolves `ready` on identity has
      // the state by the time it renders. Absent state sends nothing; the
      // client keeps whatever default it started with.
      const current = this.#state.get();
      if (current !== undefined) {
        this.#sendFrame(connection, {
          type: MessageType.CF_AGENT_STATE,
          state: current
        });
      }
    }
    await this.lifecycle.runInHostContext(
      () => this.#handlers?.onConnect?.(connection, ctx),
      { connection, request: ctx.request }
    );
  }

  async #message(
    connection: Connection,
    message: WebSocketMessage
  ): Promise<void> {
    if (this.#state && this.#applyStateFrame(connection, message)) return;
    if (
      this.#callables.size > 0 &&
      (await this.#answerRpc(connection, message))
    ) {
      return;
    }
    await this.lifecycle.runInHostContext(
      () => this.#handlers?.onMessage?.(connection, message),
      { connection }
    );
  }

  #close(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<unknown> {
    return this.lifecycle.runInHostContext(
      () => this.#handlers?.onClose?.(connection, code, reason, wasClean),
      { connection }
    );
  }

  #error(connection: Connection, error: unknown): Promise<unknown> {
    return this.lifecycle.runInHostContext(
      () => this.#handlers?.onError?.(connection, error),
      { connection }
    );
  }

  // ── Hibernating wire ───────────────────────────────────────────────────

  async #acceptConnection(request: Request): Promise<Response> {
    const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
    const url = new URL(request.url);
    // `||`, not `??`: an empty `?_pk=` value must fall back to a
    // generated id — an empty connection id would later throw in tag
    // validation and reject the upgrade.
    const connectionId = url.searchParams.get("_pk") || nanoid();

    let connection: Connection = Object.assign(serverWebSocket, {
      id: connectionId,
      uri: request.url,
      tags: [] as string[],
      state: null as unknown as ConnectionState<unknown>,
      setState<T = unknown>(setState: T | ConnectionSetStateFn<T>) {
        // Pre-accept shim: hold state on the socket until accept()
        // persists it into the hibernation attachment.
        const state =
          setState instanceof Function
            ? setState(this.state as ConnectionState<T>)
            : setState;
        this.state = state as ConnectionState<T>;
        return this.state as ConnectionState<T>;
      }
    });

    const ctx = { request };
    const tags = this.#getConnectionTags
      ? await this.#getConnectionTags(connection, ctx)
      : [];

    // Hibernating WebSockets remain connected while the object is evicted.
    connection = this.#connectionManager.accept(connection, { tags });
    await this.#connect(connection, ctx);

    return new Response(null, { status: 101, webSocket: clientWebSocket });
  }

  // ── Cap'n Web wire ─────────────────────────────────────────────────────

  async #acceptCapnWebSession(request: Request): Promise<Response> {
    const connectionId =
      new URL(request.url).searchParams.get("_pk") || nanoid();
    // A reconnect reusing the id replaces the previous session.
    this.#sessions.get(connectionId)?.dispose();

    const { response } = await openCapnWebSession({
      request,
      connectionId,
      tags: (connection, ctx) =>
        this.#getConnectionTags?.(connection, ctx) ?? [],
      onConnect: (connection, ctx) => this.#connect(connection, ctx),
      onMessage: (connection, message) => this.#message(connection, message),
      onClose: (connection, code, reason, wasClean) =>
        this.#close(connection, code, reason, wasClean).then(() => undefined),
      onError: (connection, error) =>
        this.#error(connection, error).then(() => undefined),
      callables: (connection) => this.#nativeCallables(connection),
      onOpen: (session) => this.#sessions.set(connectionId, session),
      onDispose: (ended) => {
        if (this.#sessions.get(connectionId) === ended) {
          this.#sessions.delete(connectionId);
        }
      }
    });
    return response;
  }

  // ── State ──────────────────────────────────────────────────────────────

  /**
   * Apply a client's `cf_agent_state` frame to the State capability and
   * broadcast the result to the other connections. The host's own
   * `validateStateChange` decides whether the change is allowed; a throw
   * answers the sender with `cf_agent_state_error` and changes nothing.
   *
   * @returns Whether the message was a state frame.
   */
  #applyStateFrame(connection: Connection, raw: WebSocketMessage): boolean {
    if (typeof raw !== "string") return false;
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isStateFrame(frame)) return false;
    try {
      // `set()` runs the host's validation and persists; the source is this
      // connection, so the broadcast below excludes it — it already has
      // the value it sent.
      this.#state?.set(frame.state, connection);
    } catch (error) {
      this.#sendFrame(connection, {
        type: MessageType.CF_AGENT_STATE_ERROR,
        error: error instanceof Error ? error.message : String(error)
      });
      return true;
    }
    this.broadcastState(connection);
    return true;
  }

  /**
   * Push the current state to every connection, optionally excluding the
   * one a change came from. Hosts call this after their own `setState`
   * when they want connections to see it; a change arriving from a client
   * is broadcast automatically.
   */
  broadcastState(except?: Connection): void {
    if (!this.#state) return;
    const current = this.#state.get();
    if (current === undefined) return;
    const frame = { type: MessageType.CF_AGENT_STATE, state: current };
    for (const connection of this.getConnections()) {
      if (connection.id === except?.id) continue;
      this.#sendFrame(connection, frame);
    }
  }

  /** Send one protocol frame, tolerating a peer that just disconnected. */
  #sendFrame(connection: Connection, frame: Record<string, unknown>): void {
    try {
      connection.send(JSON.stringify(frame));
    } catch {
      // The socket closed between the wake and the send.
    }
  }

  // ── Callables ──────────────────────────────────────────────────────────

  /**
   * The `callables` target as native Cap'n Web methods for one session:
   * every method dispatches through the host boundary with this
   * connection in scope and emits `rpc`/`rpc:error` events. Return values
   * keep Cap'n Web semantics — an `RpcTarget` comes back as a live stub.
   */
  #nativeCallables(
    connection: Connection
  ): ReadonlyMap<string, CallableInvoker> {
    const methods = new Map<string, CallableInvoker>();
    for (const [name, invoke] of this.#callables) {
      methods.set(name, (...args) =>
        this.#dispatchCallable(name, () => invoke(...args), connection)
      );
    }
    return methods;
  }

  /**
   * Answer one `rpc` frame against `callables`. A `ReadableStream`
   * result streams as `done: false` chunks followed by a final
   * `done: true` frame, matching the client's stream callbacks.
   *
   * @returns Whether the message was an `rpc` frame (answered or not).
   */
  async #answerRpc(
    connection: Connection,
    raw: WebSocketMessage
  ): Promise<boolean> {
    if (typeof raw !== "string") return false;
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isRpcRequest(frame)) return false;
    const { id, method, args } = frame;

    const invoke = this.#callables.get(method);
    if (!invoke) {
      this.#reply(connection, {
        type: "rpc",
        id,
        success: false,
        error: `Method ${method} does not exist`
      });
      return true;
    }

    try {
      const result = await this.#dispatchCallable(
        method,
        () => invoke(...args),
        connection
      );
      if (result instanceof RpcTarget) {
        // By-reference results only exist on the Cap'n Web wire; a JSON
        // frame would silently flatten the target to `{}`.
        throw new Error(
          `Method ${method} returns an RpcTarget, which only the capnweb transport can carry`
        );
      }
      if (result instanceof ReadableStream) {
        for await (const chunk of result) {
          this.#reply(connection, {
            type: "rpc",
            id,
            success: true,
            done: false,
            result: chunk
          });
        }
        this.#reply(connection, {
          type: "rpc",
          id,
          success: true,
          done: true,
          result: undefined
        });
      } else {
        this.#reply(connection, {
          type: "rpc",
          id,
          success: true,
          done: true,
          result
        });
      }
    } catch (error) {
      this.#reply(connection, {
        type: "rpc",
        id,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return true;
  }

  #reply(connection: Connection, response: RpcResponse): void {
    let text: string;
    try {
      text = JSON.stringify(response);
    } catch (error) {
      // A result that JSON cannot carry (a BigInt, a cycle) must still
      // settle the caller: answer with an error instead of silence.
      text = JSON.stringify({
        type: "rpc",
        id: response.id,
        success: false,
        error: `Result is not JSON-serializable: ${
          error instanceof Error ? error.message : String(error)
        }`
      } satisfies RpcResponse);
    }
    try {
      connection.send(text);
    } catch {
      // The peer disconnected while the callable was running.
    }
  }

  async #dispatchCallable(
    name: string,
    invoke: () => unknown,
    connection: Connection
  ): Promise<unknown> {
    // Throws with installation guidance when the capability was never
    // installed with Lifecycle.use().
    const services = this.lifecycle;
    try {
      const result = await services.runInHostContext(invoke, { connection });
      services.events.emit("rpc", {
        method: name,
        streaming: result instanceof ReadableStream
      });
      return result;
    } catch (error) {
      services.events.emit("rpc:error", {
        method: name,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
