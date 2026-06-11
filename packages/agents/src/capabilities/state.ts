/**
 * Synced-state capability (Layer 1). Owns the single-row state record in
 * the `cf_agents_state` table (`STATE_ROW_ID`).
 *
 * The `Agent` class delegates its `state` getter, `setState()` and the
 * internal persist + broadcast path (`_setStateInternal`) here; the
 * capability talks to the agent only through the narrow
 * {@link SyncedStateHost} slice. Note that `cf_agents_state` also stores
 * the schema-version row (`cf_schema_version`) — that row is read and
 * written exclusively by the Agent's `_ensureSchema()`, never here.
 *
 * Calls to overridable agent hooks (`validateStateChange`,
 * `onStateChanged`/`onStateUpdate`, `isConnectionReadonly`, `onError`,
 * the `initialState` field) are re-dispatched through the agent instance
 * so subclass overrides keep working exactly as before.
 */

import type { Connection } from "partyserver";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "../internal_context";
import { MessageType } from "../types";
import type { SqlHost } from "../core/host";

/** Row id of the user-facing state record in `cf_agents_state`. */
const STATE_ROW_ID = "cf_state_row_id";

/**
 * Sentinel for "state has never been set". Shared with the `Agent`
 * class, which uses it as the default for the `initialState` field.
 */
export const DEFAULT_STATE = {} as unknown;

/**
 * Persistence-hook dispatch mode, computed once per agent in the
 * constructor via {@link computeStatePersistenceHookMode}.
 * - "new"  → call onStateChanged
 * - "old"  → call onStateUpdate (deprecated)
 * - "none" → neither hook is overridden, skip entirely
 */
export type StatePersistenceHookMode = "new" | "old" | "none";

/**
 * Tracks which agent constructors have already emitted the onStateUpdate
 * deprecation warning, so it fires at most once per class.
 */
const _onStateUpdateWarnedClasses = new WeakSet<Function>();

/**
 * Compute the persistence-hook dispatch mode for an agent instance.
 * Called once from the Agent constructor.
 * Throws immediately if both hooks are overridden on the same class.
 */
export function computeStatePersistenceHookMode(
  agent: object,
  base: { onStateChanged: unknown; onStateUpdate: unknown }
): StatePersistenceHookMode {
  const proto = Object.getPrototypeOf(agent) as {
    onStateChanged: unknown;
    onStateUpdate: unknown;
  };
  const hasOwnNew = Object.prototype.hasOwnProperty.call(
    proto,
    "onStateChanged"
  );
  const hasOwnOld = Object.prototype.hasOwnProperty.call(
    proto,
    "onStateUpdate"
  );

  if (hasOwnNew && hasOwnOld) {
    throw new Error(
      `[Agent] Cannot override both onStateChanged and onStateUpdate. ` +
        `Remove onStateUpdate — it has been renamed to onStateChanged.`
    );
  }

  if (hasOwnOld) {
    const ctor = agent.constructor;
    if (!_onStateUpdateWarnedClasses.has(ctor)) {
      _onStateUpdateWarnedClasses.add(ctor);
      console.warn(
        `[Agent] onStateUpdate is deprecated. Rename to onStateChanged — the behavior is identical.`
      );
    }
  }

  if (proto.onStateChanged !== base.onStateChanged) {
    return "new";
  }
  if (proto.onStateUpdate !== base.onStateUpdate) {
    return "old";
  }
  return "none";
}

/**
 * The public Agent surface the capability re-dispatches through so
 * subclass overrides are honored (these members are all overridable).
 */
interface SyncedStateAgentSurface<State> {
  initialState: State;
  isConnectionReadonly(connection: Connection): boolean;
  validateStateChange(nextState: State, source: Connection | "server"): void;
  onStateChanged(
    state: State | undefined,
    source: Connection | "server"
  ): void | Promise<void>;
  onStateUpdate(
    state: State | undefined,
    source: Connection | "server"
  ): void | Promise<void>;
  onError(e: unknown): void | Promise<void>;
}

/** The slice of the agent the synced-state capability needs. */
export interface SyncedStateHost {
  /**
   * The agent instance — ALS context value; overridable hooks
   * (`validateStateChange`, `onStateChanged`/`onStateUpdate`, …) are
   * re-dispatched through it so subclass overrides are honored.
   */
  agent: object;
  sql: SqlHost["sql"];
  /**
   * `_broadcastProtocol` — broadcast a protocol frame to all
   * protocol-enabled connections, excluding `excludeIds`.
   */
  broadcastProtocol(msg: string, excludeIds?: string[]): void;
  /** `_emit("state:update")` observability event. */
  emitStateUpdate(): void;
  /** Persistence-hook dispatch mode cached in the Agent constructor. */
  hookMode(): StatePersistenceHookMode;
  /** `ctx.waitUntil` — keeps the persistence hook alive after return. */
  waitUntil(promise: Promise<unknown>): void;
}

export class AgentSyncedState<State> {
  private readonly _host: SyncedStateHost;
  private _state = DEFAULT_STATE as State;

  constructor(host: SyncedStateHost) {
    this._host = host;
  }

  private get _agent(): SyncedStateAgentSurface<State> {
    return this._host.agent as SyncedStateAgentSurface<State>;
  }

  /**
   * Current state of the Agent — lazily loaded from `cf_agents_state`
   * on first access, falling back to `initialState`.
   */
  get state(): State {
    if (this._state !== DEFAULT_STATE) {
      // state was previously set, and populated internal state
      return this._state;
    }
    // looks like this is the first time the state is being accessed
    // check if the state was set in a previous life
    const result = this._host.sql<{ state: State | undefined }>`
      SELECT state FROM cf_agents_state WHERE id = ${STATE_ROW_ID}
    `;

    // Row existence is the signal that state was previously set.
    // This handles all values including falsy ones (null, 0, false, "").
    if (result.length > 0) {
      const state = result[0].state as string;

      try {
        this._state = JSON.parse(state);
      } catch (e) {
        console.error(
          "Failed to parse stored state, falling back to initialState:",
          e
        );
        if (this._agent.initialState !== DEFAULT_STATE) {
          this._state = this._agent.initialState;
          // Persist the fixed state to prevent future parse errors
          this.setStateInternal(this._agent.initialState);
        } else {
          // No initialState defined - clear corrupted data to prevent infinite retry loop
          this._host
            .sql`DELETE FROM cf_agents_state WHERE id = ${STATE_ROW_ID}`;
          return undefined as State;
        }
      }
      return this._state;
    }

    // ok, this is the first time the state is being accessed
    // and the state was not set in a previous life
    // so we need to set the initial state (if provided)
    if (this._agent.initialState === DEFAULT_STATE) {
      // no initial state provided, so we return undefined
      return undefined as State;
    }
    // initial state provided, so we set the state,
    // update db and return the initial state
    this.setStateInternal(this._agent.initialState);
    return this._agent.initialState;
  }

  /**
   * Update the Agent's state — readonly-connection guard, then the
   * internal persist + broadcast path with source "server".
   */
  setState(state: State): void {
    // Check if the current context has a readonly connection
    const store = agentContext.getStore();
    if (
      store?.connection &&
      this._agent.isConnectionReadonly(store.connection)
    ) {
      throw new Error("Connection is readonly");
    }
    this.setStateInternal(state, "server");
  }

  /**
   * Validate, persist, broadcast (excluding the source connection) and
   * dispatch the persistence hook for a state update.
   */
  setStateInternal(
    nextState: State,
    source: Connection | "server" = "server"
  ): void {
    // Validation/gating hook (sync only)
    this._agent.validateStateChange(nextState, source);

    // Persist state — row existence in cf_agents_state is the signal that
    // state was set (no separate wasChanged flag needed).
    this._state = nextState;
    this._host.sql`
      INSERT OR REPLACE INTO cf_agents_state (id, state)
      VALUES (${STATE_ROW_ID}, ${JSON.stringify(nextState)})
    `;

    // Broadcast state to protocol-enabled connections, excluding the source
    this._host.broadcastProtocol(
      JSON.stringify({
        state: nextState,
        type: MessageType.CF_AGENT_STATE
      }),
      source !== "server" ? [source.id] : []
    );

    // Notification hook (non-gating). Run after broadcast and do not block.
    // Use waitUntil for reliability after the handler returns.
    const { connection, request, email } = agentContext.getStore() || {};
    this._host.waitUntil(
      (async () => {
        try {
          await agentContext.run(
            { agent: this._host.agent, connection, request, email },
            async () => {
              this._host.emitStateUpdate();
              await this._callStatePersistenceHook(nextState, source);
            }
          );
        } catch (e) {
          // onStateChanged/onStateUpdate errors should not affect state or broadcasts
          try {
            await this._agent.onError(e);
          } catch {
            // swallow
          }
        }
      })()
    );
  }

  /**
   * Dispatch to the appropriate persistence hook based on the mode
   * cached in the Agent constructor. No prototype walks at call time.
   */
  private async _callStatePersistenceHook(
    state: State | undefined,
    source: Connection | "server"
  ): Promise<void> {
    switch (this._host.hookMode()) {
      case "new":
        await this._agent.onStateChanged(state, source);
        break;
      case "old":
        await this._agent.onStateUpdate(state, source);
        break;
      // "none": neither hook overridden — skip
    }
  }
}
