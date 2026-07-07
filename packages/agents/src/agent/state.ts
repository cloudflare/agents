/**
 * Agent state subsystem.
 *
 * "State" is a single JSON-serializable value owned by one Agent instance
 * (one Durable Object). It is read with `agent.state` and replaced wholesale
 * with `agent.setState(next)` — there are no partial updates.
 *
 * What makes it more than a plain field is that it is durable and live:
 * - Durable: persisted as one row in the `cf_agents_state` SQLite table and
 *   lazily rehydrated into an in-memory cache on the first read of a cold
 *   isolate, so it survives hibernation and reconnects.
 * - Live: `setState` (from the server or from a connected client) persists the
 *   value and broadcasts it over WebSocket so the server and every connected
 *   client stay in agreement, with the browser `useAgent` hook re-rendering on
 *   each change.
 *
 * Use it for the small, canonical snapshot clients should watch update in real
 * time (session/task status, progress, collaborative counters). For large or
 * relational data (message history, logs) use the agent's raw SQL instead;
 * `state` is loaded and rewritten whole and broadcast on every change, so keep
 * it small.
 *
 * This module owns that behaviour (`AgentState`), the connection-state flag
 * machinery (readonly / no-protocol), and the state-change hook dispatch. The
 * `Agent` class holds an `AgentState` instance and delegates to it; see
 * `AgentStateApi` for the curated, public-ready subset.
 */
import type { AgentEmail } from "../internal_context";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "../internal_context";
import { MessageType } from "../types";
import type { Connection } from "partyserver";

// Row id for the agent's user-visible state in cf_agents_state.
// A separate SCHEMA_VERSION_ROW_ID row in the same table tracks migrations.
const STATE_ROW_ID = "cf_state_row_id";

/**
 * Sentinel used as the initial value of the in-memory state cache.
 * Comparing against this object (by reference) is how we detect that state
 * has never been set in this isolate and needs to be loaded from SQLite.
 *
 * Exported so Agent can initialise its own `initialState` field to the same
 * sentinel and so the strangler-pattern `_state` bridge accessor can read it.
 */
export const DEFAULT_STATE = {} as unknown;

/**
 * Internal key used to store the readonly flag in connection state.
 * Prefixed with _cf_ to avoid collision with user state keys.
 */
const CF_READONLY_KEY = "_cf_readonly";

/**
 * Internal key used to store the no-protocol flag in connection state.
 * When set, protocol messages (identity, state sync, MCP servers) are not
 * sent to this connection — neither on connect nor via broadcasts.
 */
const CF_NO_PROTOCOL_KEY = "_cf_no_protocol";

/**
 * Internal key used to store voice call state in connection state.
 * Used by the voice mixin to track whether a connection is in an active call.
 */
const CF_VOICE_IN_CALL_KEY = "_cf_voiceInCall";

/**
 * Internal key used to remember the outer `/sub/...` URL for a
 * WebSocket accepted by the parent on behalf of a child facet.
 * Hibernated events then wake the parent, which forwards frames to
 * the child over serializable RPC while keeping native WebSocket I/O
 * parent-owned.
 */
const CF_SUB_AGENT_OUTER_URL_KEY = "_cf_subAgentOuterUrl";
const CF_SUB_AGENT_TAGS_KEY = "_cf_subAgentTags";

/**
 * The set of all internal keys stored in connection state that must be
 * hidden from user code and preserved across setState calls.
 */
const CF_INTERNAL_KEYS: ReadonlySet<string> = new Set([
  CF_READONLY_KEY,
  CF_NO_PROTOCOL_KEY,
  CF_VOICE_IN_CALL_KEY,
  CF_SUB_AGENT_OUTER_URL_KEY,
  CF_SUB_AGENT_TAGS_KEY
]);

// ── Connection-state key helpers ──────────────────────────────────────────────

type StateSource = Connection | "server";

/** Raw getter/setter pair captured from a connection before we override it. */
type RawConnectionStateAccessors = {
  getRaw: () => Record<string, unknown> | null;
  setRaw: (state: unknown) => unknown;
};

/** Check if a raw connection state object contains any internal keys. */
function rawHasInternalKeys(raw: Record<string, unknown>): boolean {
  for (const key of Object.keys(raw)) {
    if (CF_INTERNAL_KEYS.has(key)) return true;
  }
  return false;
}

/** Return a copy of `raw` with all internal keys removed, or null if no user keys remain. */
function stripInternalKeys(
  raw: Record<string, unknown>
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  let hasUserKeys = false;
  for (const key of Object.keys(raw)) {
    if (!CF_INTERNAL_KEYS.has(key)) {
      result[key] = raw[key];
      hasUserKeys = true;
    }
  }
  return hasUserKeys ? result : null;
}

/** Return a copy containing only the internal keys present in `raw`. */
function extractInternalFlags(
  raw: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (CF_INTERNAL_KEYS.has(key)) {
      result[key] = raw[key];
    }
  }
  return result;
}

// ── AgentStateHost ────────────────────────────────────────────────────────────

/**
 * Which state-change notification hook to invoke after a state change is
 * persisted and broadcast.
 *
 * The "persistence hook" is the user-overridable callback an Agent subclass can
 * define to react to state changes: `onStateChanged(state, source)` (current
 * name) or `onStateUpdate(state, source)` (the deprecated alias, kept for
 * backwards compatibility). It runs after the new state has already been
 * written to SQLite and broadcast to clients, so it is a notification, not a
 * gate — throwing from it cannot undo the change (contrast `validateStateChange`,
 * which runs before and can reject).
 *
 * Rather than walk the prototype chain on every `setState` to discover whether
 * a subclass overrode either hook, the Agent constructor resolves this once and
 * stores the result. The dispatch on the hot path is then a single switch:
 *
 * - "new"  → the subclass overrode `onStateChanged`; call it.
 * - "old"  → the subclass overrode only the deprecated `onStateUpdate`; call it.
 * - "none" → neither hook is overridden; skip the call entirely.
 */
export type StatePersistenceHookMode = "new" | "old" | "none";

/**
 * Narrow interface that `AgentState` uses to call back into `Agent`.
 * Keeping this small avoids coupling state logic to the full Agent class.
 */
export type AgentStateHost<State> = {
  /** The agent instance — used to restore agentContext when running hooks. */
  agent: unknown;
  ctx: DurableObjectState;
  /** The user-declared initial state, or DEFAULT_STATE if none was provided. */
  initialState: State;
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
  getConnections(): Iterable<Connection>;
  broadcast(message: string, without?: string[]): void;
  validateStateChange(nextState: State, source: StateSource): void;
  onStateChanged(state: State | undefined, source: StateSource): unknown;
  onStateUpdate(state: State | undefined, source: StateSource): unknown;
  onError(error: unknown): unknown;
  _emit(type: "state:update", payload?: Record<string, unknown>): void;
};

// ── AgentStateApi (public-ready surface) ──────────────────────────────────────

/**
 * The curated, user-facing subset of `AgentState`.
 *
 * `AgentState` implements this interface. Everything not listed here
 * (persistence-hook wiring, the ungated `setInternal` write path,
 * protocol-broadcast internals, connection wrapping, and the `unsafe*` flag
 * accessors) is framework plumbing and deliberately excluded.
 *
 * This type is not part of the package's published API yet. It exists so that
 * a future major version can expose the state subsystem as `agent.stateOps`
 * typed as `AgentStateApi<State>` — dropping the thin `state` / `setState`
 * wrappers from the `Agent` class — without leaking the internal methods that
 * currently live on the same object.
 */
export interface AgentStateApi<State> {
  /**
   * The current agent state. Lazily loaded from SQLite on first access within
   * a cold isolate; falls back to the declared `initialState` when unset.
   */
  readonly state: State;

  /**
   * Update the agent state. Persists to SQLite, broadcasts to connected
   * clients, and fires the state-change hook.
   *
   * @throws Error if called from a readonly connection context.
   */
  setState(state: State): void;

  /** Mark a connection as readonly or readwrite (default: readonly). */
  setConnectionReadonly(connection: Connection, readonly?: boolean): void;

  /** Whether a connection is marked readonly. */
  isConnectionReadonly(connection: Connection): boolean;

  /**
   * Whether a connection receives protocol messages (identity, state sync,
   * MCP server lists).
   */
  isConnectionProtocolEnabled(connection: Connection): boolean;
}

// ── AgentState ────────────────────────────────────────────────────────────────

/**
 * Encapsulates all state-management behaviour for an Agent instance.
 *
 * Owns:
 * - The in-memory state cache (`#state`)
 * - The raw connection-state accessor map used to read/write internal flags
 *   without going through the user-facing connection.state wrapper
 * - The persistence-hook dispatch mode (new / old / none)
 * - The set of connection IDs that are temporarily excluded from protocol
 *   broadcasts (used during initial state sync on connect)
 *
 * `Agent` holds a `_state` field of this type and delegates to it. The
 * `AgentStateHost` callback interface keeps this class decoupled from the full
 * Agent class.
 *
 * The public-ready subset of this class is described by `AgentStateApi`; the
 * remaining methods are marked `@internal` and grouped after it.
 */
export class AgentState<State> implements AgentStateApi<State> {
  #host: AgentStateHost<State>;

  /** In-memory state cache. DEFAULT_STATE means "not yet loaded from SQLite". */
  #state = DEFAULT_STATE as State;

  /**
   * Stores raw state accessors for wrapped connections.
   * Used by internal flag methods (readonly, no-protocol) to read/write
   * _cf_-prefixed keys without going through the user-facing state/setState.
   */
  #rawStateAccessors = new WeakMap<Connection, RawConnectionStateAccessors>();

  /**
   * Which state-change notification hook to fire after a change is persisted.
   * Resolved once by the Agent constructor (see `setPersistenceHookMode`) so
   * the hot path never walks the prototype chain. Defaults to "none" until the
   * constructor detects an overridden hook. See {@link StatePersistenceHookMode}.
   */
  #persistenceHookMode: StatePersistenceHookMode = "none";

  /**
   * Connection IDs to skip during `broadcastProtocol`. Populated temporarily
   * during initial state sync on connect to avoid double-sending state to the
   * connecting client.
   */
  #protocolBroadcastExcludeIds = new Set<string>();

  constructor(host: AgentStateHost<State>) {
    this.#host = host;
  }

  // ── Public API (future `agent.stateOps`, see AgentStateApi) ───────────────────

  /**
   * Return the current agent state.
   *
   * On first access within a cold isolate, checks the in-memory cache; if that
   * holds the DEFAULT_STATE sentinel, reads from SQLite. Row existence in
   * cf_agents_state is the signal that state was previously set — this handles
   * all values including falsy ones (null, 0, false, ""). If no row exists and
   * `initialState` was provided, persists and returns that.
   */
  get state(): State {
    if (this.#state !== DEFAULT_STATE) {
      return this.#state;
    }

    const result = this.#host.sql<{ state: State | undefined }>`
      SELECT state FROM cf_agents_state WHERE id = ${STATE_ROW_ID}
    `;

    if (result.length > 0) {
      const state = result[0].state as string;

      try {
        this.#state = JSON.parse(state);
      } catch (e) {
        console.error(
          "Failed to parse stored state, falling back to initialState:",
          e
        );
        if (this.#host.initialState !== DEFAULT_STATE) {
          this.#state = this.#host.initialState;
          // Persist the fixed state to prevent future parse errors
          this.setInternal(this.#host.initialState);
        } else {
          // No initialState defined — clear corrupted data to prevent infinite retry loop
          this.#host
            .sql`DELETE FROM cf_agents_state WHERE id = ${STATE_ROW_ID}`;
          return undefined as State;
        }
      }
      return this.#state;
    }

    if (this.#host.initialState === DEFAULT_STATE) {
      return undefined as State;
    }

    // First access with no prior state — persist initialState and return it.
    this.setInternal(this.#host.initialState);
    return this.#host.initialState;
  }

  /**
   * Public entry point for `Agent.setState()`.
   * Checks the current agentContext for a readonly connection before delegating
   * to `setInternal`.
   */
  setState(state: State): void {
    const store = agentContext.getStore();
    if (store?.connection && this.isConnectionReadonly(store.connection)) {
      throw new Error("Connection is readonly");
    }
    this.setInternal(state, "server");
  }

  // ── State persistence internals (not part of AgentStateApi) ───────────────────

  /**
   * @internal Called once from the Agent constructor after it detects which
   * state-change hook (if any) the subclass overrode, fixing which hook
   * `setInternal` fires. See {@link StatePersistenceHookMode}.
   */
  setPersistenceHookMode(mode: StatePersistenceHookMode): void {
    this.#persistenceHookMode = mode;
  }

  /**
   * @internal Read the raw cached state value.
   * Used by the strangler-pattern `_state` accessor bridge on Agent so that
   * existing code that reads `this._state` (including test helpers) keeps
   * working without modification during the extraction.
   */
  getCachedState(): State {
    return this.#state;
  }

  /**
   * @internal Overwrite the raw cached state value without persisting or
   * broadcasting.
   * Used by the strangler-pattern `_state` accessor bridge on Agent so that
   * test helpers that force-reset `this._state` to the DEFAULT_STATE sentinel
   * (to simulate a "lazy init" path) can still do so.
   */
  setCachedState(state: State): void {
    this.#state = state;
  }

  /**
   * @internal
   * Persist, broadcast, and fire hooks for a state change.
   *
   * - Calls `validateStateChange` (sync gating hook — may throw to reject).
   * - Writes the new value to the in-memory cache and SQLite.
   * - Broadcasts the new state to all protocol-enabled connections except the
   *   source connection (if the update came from a client).
   * - Schedules the notification hook (`onStateChanged` / `onStateUpdate`) via
   *   `waitUntil` so it runs reliably even if the handler has already returned.
   *   Errors in the hook are routed to `onError` and do not affect the persist
   *   or broadcast that already happened.
   */
  setInternal(nextState: State, source: StateSource = "server"): void {
    // Validation/gating hook (sync only)
    this.#host.validateStateChange(nextState, source);

    // Persist state — row existence in cf_agents_state is the signal that
    // state was set (no separate wasChanged flag needed).
    this.#state = nextState;
    this.#host.sql`
      INSERT OR REPLACE INTO cf_agents_state (id, state)
      VALUES (${STATE_ROW_ID}, ${JSON.stringify(nextState)})
    `;

    // Broadcast state to protocol-enabled connections, excluding the source
    this.broadcastProtocol(
      JSON.stringify({
        state: nextState,
        type: MessageType.CF_AGENT_STATE
      }),
      source !== "server" ? [source.id] : []
    );

    // Notification hook (non-gating). Run after broadcast and do not block.
    // Use waitUntil for reliability after the handler returns.
    const { connection, request, email } = agentContext.getStore() || {};
    this.#host.ctx.waitUntil(
      this.#runPersistenceHook(nextState, source, {
        connection,
        request,
        email
      })
    );
  }

  /**
   * @internal Broadcast a protocol message only to connections that have
   * protocol messages enabled. Connections where `shouldSendProtocolMessages`
   * returned false are excluded automatically, as are any IDs in
   * `#protocolBroadcastExcludeIds` and the `excludeIds` argument.
   */
  broadcastProtocol(msg: string, excludeIds: string[] = []): void {
    const exclude = [...excludeIds, ...this.#protocolBroadcastExcludeIds];
    for (const conn of this.#host.getConnections()) {
      if (!this.isConnectionProtocolEnabled(conn)) {
        exclude.push(conn.id);
      }
    }
    this.#host.broadcast(msg, exclude);
  }

  /**
   * @internal
   * Temporarily exclude a connection from protocol broadcasts for the duration
   * of `callback`, then restore the previous exclusion state.
   *
   * Used during initial state sync on connect: reading `this.state` can trigger
   * lazy persistence of `initialState`, which in turn calls `setInternal` and
   * broadcasts — but we want to send the state to the connecting client in a
   * single targeted message, not via the broadcast path.
   */
  excludeConnectionFromProtocolBroadcast<T>(
    connectionId: string,
    callback: () => T
  ): T {
    const wasExcluded = this.#protocolBroadcastExcludeIds.has(connectionId);
    this.#protocolBroadcastExcludeIds.add(connectionId);
    try {
      return callback();
    } finally {
      if (!wasExcluded) {
        this.#protocolBroadcastExcludeIds.delete(connectionId);
      }
    }
  }

  // ── Connection state (readonly + protocol flags) ─────────────────────────────

  /**
   * @internal
   * Wraps `connection.state` and `connection.setState` so that internal
   * `_cf_`-prefixed flags (readonly, no-protocol, sub-agent URL, etc.) are
   * hidden from user code and cannot be accidentally overwritten.
   *
   * Idempotent — safe to call multiple times on the same connection.
   * After hibernation, `#rawStateAccessors` is empty but the connection's state
   * getter still reads from the persisted WebSocket attachment. Calling this
   * method re-captures the raw getter so that predicate methods
   * (`isConnectionReadonly`, `isConnectionProtocolEnabled`) work correctly
   * post-hibernation.
   */
  ensureConnectionWrapped(connection: Connection): void {
    if (this.#rawStateAccessors.has(connection)) return;

    // As of compatibility date 2026-03-17 the runtime defaults a server-side
    // WebSocket's `binaryType` to "blob" (the `websocket_standard_binary_type`
    // flag), so binary frames arrive as `Blob` instead of `ArrayBuffer`. The
    // Agent protocol and every downstream consumer (e.g. voice audio frames,
    // user-defined `onMessage` handlers that do `message instanceof ArrayBuffer`)
    // have always relied on binary frames being delivered as `ArrayBuffer`.
    //
    // For non-hibernating agents (`static options = { hibernate: false }`)
    // messages are delivered through `addEventListener("message", ...)`, where
    // this new default applies and would silently break binary handling. Pin
    // it back to "arraybuffer" so the contract holds regardless of the app's
    // compatibility date. This first runs in `onConnect` before the client can
    // send any frame, so it takes effect for every message on the connection.
    //
    // This is defense-in-depth: partyserver >= 0.5.7 also pins `binaryType` in
    // `accept()`, but agents may run against an older partyserver or a custom
    // connection, so we keep our own pin. It runs once per connection per
    // isolate lifetime (gated by the `#rawStateAccessors` check above); after a
    // hibernation wake that in-memory map is empty, so it re-pins on the first
    // call. The hibernatable `webSocketMessage` handler always delivers
    // `ArrayBuffer` regardless of this flag, so for hibernating agents this is a
    // harmless no-op.
    try {
      if (connection.binaryType !== "arraybuffer") {
        connection.binaryType = "arraybuffer";
      }
    } catch {
      // Some connection shims may not expose a settable `binaryType`; the
      // protocol still works for string frames, so ignore and continue.
    }

    // Determine whether `state` is an accessor (getter) or a data property.
    // partyserver always defines `state` as a getter via Object.defineProperties,
    // but we handle the data-property case to stay robust for hibernate: false
    // and any future connection implementations.
    const descriptor = Object.getOwnPropertyDescriptor(connection, "state");

    let getRaw: () => Record<string, unknown> | null;
    let setRaw: (state: unknown) => unknown;

    if (descriptor?.get) {
      // Accessor property — bind the original getter directly.
      // The getter reads from the serialized WebSocket attachment, so it
      // always returns the latest value even after setState updates it.
      getRaw = descriptor.get.bind(connection) as () => Record<
        string,
        unknown
      > | null;
      setRaw = connection.setState.bind(connection);
    } else {
      // Data property — track raw state in a closure variable.
      // Reading `connection.state` after our override would call our filtered
      // getter (circular), so we snapshot the value here and keep it in sync.
      let rawState = (connection.state ?? null) as Record<
        string,
        unknown
      > | null;
      getRaw = () => rawState;
      setRaw = (state: unknown) => {
        rawState = state as Record<string, unknown> | null;
        return rawState;
      };
    }

    this.#rawStateAccessors.set(connection, { getRaw, setRaw });

    // Override state getter to hide all internal _cf_ flags from user code
    Object.defineProperty(connection, "state", {
      configurable: true,
      enumerable: true,
      get() {
        const raw = getRaw();
        if (raw != null && typeof raw === "object" && rawHasInternalKeys(raw)) {
          return stripInternalKeys(raw);
        }
        return raw;
      }
    });

    // Override setState to preserve internal flags when user sets state
    Object.defineProperty(connection, "setState", {
      configurable: true,
      writable: true,
      value(stateOrFn: unknown | ((prev: unknown) => unknown)) {
        const raw = getRaw();
        const flags =
          raw != null && typeof raw === "object"
            ? extractInternalFlags(raw as Record<string, unknown>)
            : {};
        const hasFlags = Object.keys(flags).length > 0;

        let newUserState: unknown;
        if (typeof stateOrFn === "function") {
          // Pass only the user-visible state (without internal flags) to the callback
          const userVisible = hasFlags
            ? stripInternalKeys(raw as Record<string, unknown>)
            : raw;
          newUserState = (stateOrFn as (prev: unknown) => unknown)(userVisible);
        } else {
          newUserState = stateOrFn;
        }

        // Merge back internal flags if any were set
        if (hasFlags) {
          if (newUserState != null && typeof newUserState === "object") {
            return setRaw({
              ...(newUserState as Record<string, unknown>),
              ...flags
            });
          }
          // User set null — store just the flags
          return setRaw(flags);
        }
        return setRaw(newUserState);
      }
    });
  }

  /**
   * Part of AgentStateApi.
   * Mark a connection as readonly or readwrite.
   * Removes the key entirely when clearing readonly to avoid dead keys
   * accumulating in the connection attachment.
   */
  setConnectionReadonly(connection: Connection, readonly = true): void {
    this.ensureConnectionWrapped(connection);
    const accessors = this.#rawStateAccessors.get(connection)!;
    const raw = (accessors.getRaw() as Record<string, unknown> | null) ?? {};
    if (readonly) {
      accessors.setRaw({ ...raw, [CF_READONLY_KEY]: true });
    } else {
      const { [CF_READONLY_KEY]: _, ...rest } = raw;
      accessors.setRaw(Object.keys(rest).length > 0 ? rest : null);
    }
  }

  /**
   * Part of AgentStateApi.
   * Check if a connection is marked as readonly.
   * Safe to call after hibernation — re-wraps the connection if the
   * in-memory accessor cache was cleared.
   */
  isConnectionReadonly(connection: Connection): boolean {
    this.ensureConnectionWrapped(connection);
    const raw = this.#rawStateAccessors.get(connection)!.getRaw() as Record<
      string,
      unknown
    > | null;
    return !!raw?.[CF_READONLY_KEY];
  }

  /**
   * @internal
   * Read an internal `_cf_`-prefixed flag from the raw connection state,
   * bypassing the user-facing state wrapper that strips internal keys.
   *
   * This exists for framework mixins (e.g. voice) that need to persist
   * flags in the connection attachment across hibernation. Application
   * code should use `connection.state` and `connection.setState()` instead.
   * Exposed on Agent as `_unsafe_getConnectionFlag`.
   */
  unsafeGetConnectionFlag(connection: Connection, key: string): unknown {
    this.ensureConnectionWrapped(connection);
    const raw = this.#rawStateAccessors.get(connection)!.getRaw() as Record<
      string,
      unknown
    > | null;
    return raw?.[key];
  }

  /**
   * @internal
   * Write an internal `_cf_`-prefixed flag to the raw connection state,
   * bypassing the user-facing state wrapper. The key must be registered in
   * `CF_INTERNAL_KEYS` so it is preserved across user `setState` calls and
   * hidden from `connection.state`. Pass `undefined` to remove the key.
   * Exposed on Agent as `_unsafe_setConnectionFlag`.
   */
  unsafeSetConnectionFlag(
    connection: Connection,
    key: string,
    value: unknown
  ): void {
    this.ensureConnectionWrapped(connection);
    const accessors = this.#rawStateAccessors.get(connection)!;
    const raw = (accessors.getRaw() as Record<string, unknown> | null) ?? {};
    if (value === undefined) {
      const { [key]: _, ...rest } = raw;
      accessors.setRaw(Object.keys(rest).length > 0 ? rest : null);
    } else {
      accessors.setRaw({ ...raw, [key]: value });
    }
  }

  /**
   * @internal
   * Return the full raw connection state including internal `_cf_` flags.
   * Used by sub-agent forwarding code that needs to read flags like
   * `_cf_subAgentOuterUrl` without stripping them.
   */
  getRawConnectionState(connection: Connection): unknown {
    this.ensureConnectionWrapped(connection);
    return this.#rawStateAccessors.get(connection)?.getRaw() ?? null;
  }

  /**
   * Part of AgentStateApi.
   * Check if a connection has protocol messages enabled.
   * Protocol messages include identity, state sync, and MCP server lists.
   * Safe to call after hibernation — re-wraps the connection if the
   * in-memory accessor cache was cleared.
   */
  isConnectionProtocolEnabled(connection: Connection): boolean {
    this.ensureConnectionWrapped(connection);
    const raw = this.#rawStateAccessors.get(connection)!.getRaw() as Record<
      string,
      unknown
    > | null;
    return !raw?.[CF_NO_PROTOCOL_KEY];
  }

  /**
   * @internal
   * Mark a connection as having protocol messages disabled.
   * Called internally when `shouldSendProtocolMessages` returns false.
   */
  setConnectionNoProtocol(connection: Connection): void {
    this.ensureConnectionWrapped(connection);
    const accessors = this.#rawStateAccessors.get(connection)!;
    const raw = (accessors.getRaw() as Record<string, unknown> | null) ?? {};
    accessors.setRaw({ ...raw, [CF_NO_PROTOCOL_KEY]: true });
  }

  /**
   * Dispatch to whichever state-change notification hook the subclass defined,
   * using the mode resolved at construction time so there is no prototype walk
   * at call time. See {@link StatePersistenceHookMode}.
   */
  #callPersistenceHook(state: State | undefined, source: StateSource) {
    switch (this.#persistenceHookMode) {
      case "new":
        return this.#host.onStateChanged(state, source);
      case "old":
        return this.#host.onStateUpdate(state, source);
      case "none":
        return undefined;
    }
  }

  /**
   * Run the persistence hook inside the saved agentContext so that
   * `getCurrentAgent()` returns the correct agent during the hook.
   * Errors are routed to `onError` and do not affect the persist or broadcast
   * that already happened.
   */
  async #runPersistenceHook(
    state: State | undefined,
    source: StateSource,
    context: {
      connection: Connection | undefined;
      request: Request | undefined;
      email: AgentEmail | undefined;
    }
  ): Promise<void> {
    try {
      await agentContext.run(
        { agent: this.#host.agent, ...context },
        async () => {
          this.#host._emit("state:update");
          await this.#callPersistenceHook(state, source);
        }
      );
    } catch (e) {
      try {
        await this.#host.onError(e);
      } catch {
        // onStateChanged/onStateUpdate errors should not affect state or broadcasts.
      }
    }
  }
}
