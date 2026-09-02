import { LifecycleCapability } from "../lifecycle/capability";
import type { StateChangeSource, StateManagerOptions } from "./options";

export type { StateChangeSource, StateManagerOptions } from "./options";

/**
 * Namespaced KV key holding this capability's schema version. Kept separate
 * from the host's global schema version so State owns its own migrations
 * without gating the host's DDL.
 */
const STATE_SCHEMA_VERSION_KEY = "cf_agents:state_schema_version";
const CURRENT_STATE_SCHEMA_VERSION = 1;

/** Row id under which the single state value is stored in `cf_agents_state`. */
const STATE_ROW_ID = "cf_state_row_id";

/**
 * Sentinel distinguishing "state not yet loaded / never set" from a stored
 * value. A distinct object reference means falsy states (null, 0, false, "")
 * still read back as set.
 */
const DEFAULT_STATE = {} as unknown;

/**
 * Durable state storage for a Lifecycle Object.
 *
 * Owns the `cf_agents_state` state row, lazy load with an in-memory cache, and
 * validated persistence. Install the instance with `Lifecycle.use()`. State
 * validation and the post-change notification hook stay on the host, which
 * injects both callbacks. This capability never touches connections.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class StateManager<State = unknown> extends LifecycleCapability {
  private _state = DEFAULT_STATE as State;
  private _tableEnsured = false;
  private readonly _options: StateManagerOptions<State>;

  /**
   * Create a durable state capability.
   *
   * @param options - Optional initial state and a synchronous validation hook
   * injected by the host.
   */
  constructor(options: StateManagerOptions<State> = {}) {
    super("state");
    this._options = options;
  }

  // ── Lifecycle capability hooks ─────────────────────────────────────────────

  /** Initialize state storage during Lifecycle startup. */
  async onStart(): Promise<void> {
    const version =
      (await this.lifecycle.storage.get<number>(STATE_SCHEMA_VERSION_KEY)) ?? 0;
    if (version >= CURRENT_STATE_SCHEMA_VERSION) {
      this._tableEnsured = true;
      return;
    }

    this._ensureTable();
    await this.lifecycle.storage.put(
      STATE_SCHEMA_VERSION_KEY,
      CURRENT_STATE_SCHEMA_VERSION
    );
  }

  private _ensureTable(): void {
    if (this._tableEnsured) return;
    this.lifecycle.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_state (
        id TEXT PRIMARY KEY NOT NULL,
        state TEXT
      )
    `;
    this._tableEnsured = true;
  }

  /**
   * Drop the in-memory cache so the next {@link get} reloads from storage
   * (and re-seeds the initial state if the row is absent). Mirrors what a
   * hibernation wake-up does to the cache; intended for host-internal use and
   * tests that exercise the lazy-load path in a single live instance.
   */
  __resetCacheForTesting(): void {
    this._state = DEFAULT_STATE as State;
  }

  // ── State access ───────────────────────────────────────────────────────────

  /**
   * Current state.
   *
   * Loads lazily from storage on first access and caches in memory. Row
   * existence in `cf_agents_state` is the signal that state was previously
   * set, so falsy values persist correctly. On a corrupt row, falls back to
   * the initial state (re-persisting it) or clears the row.
   */
  get(): State | undefined {
    if (this._state !== DEFAULT_STATE) {
      // state was previously set, and populated internal state
      return this._state;
    }
    // looks like this is the first time the state is being accessed
    // check if the state was set in a previous life
    this._ensureTable();
    const result = this.lifecycle.sql<{ state: State | undefined }>`
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
        const initial = this._options.initialState;
        if (initial !== undefined) {
          this._state = initial;
          // Persist the fixed state to prevent future parse errors
          this.set(initial, "server");
        } else {
          // No initialState defined - clear corrupted data to prevent infinite retry loop
          this.lifecycle
            .sql`DELETE FROM cf_agents_state WHERE id = ${STATE_ROW_ID}`;
          return undefined;
        }
      }
      return this._state;
    }

    // ok, this is the first time the state is being accessed
    // and the state was not set in a previous life
    // so we need to set the initial state (if provided)
    const initial = this._options.initialState;
    if (initial === undefined) {
      // no initial state provided, so we return undefined
      return undefined;
    }
    // initial state provided, so we set the state,
    // update db and return the initial state
    this.set(initial, "server");
    return initial;
  }

  /**
   * Validate and persist a state change, then call the change hook.
   *
   * @param nextState - The new state to persist.
   * @param source - `"server"` for host-originated changes, or the originating
   * connection for client-originated changes.
   * @throws Whatever the injected `validateStateChange` throws.
   */
  set(nextState: State, source: StateChangeSource = "server"): void {
    // Validation/gating hook (sync only)
    this._options.validateStateChange?.(nextState, source);
    this._ensureTable();

    // Persist state — row existence in cf_agents_state is the signal that
    // state was set (no separate wasChanged flag needed).
    this._state = nextState;
    this.lifecycle.sql`
      INSERT OR REPLACE INTO cf_agents_state (id, state)
      VALUES (${STATE_ROW_ID}, ${JSON.stringify(nextState)})
    `;

    let pending: void | Promise<void>;
    try {
      pending = this._options.onChanged?.(nextState, source);
    } catch (error) {
      console.error("StateManager onChanged hook failed:", error);
      return;
    }

    if (pending) {
      this.lifecycle.waitUntil(
        pending.catch((error) => {
          console.error("StateManager onChanged hook failed:", error);
        })
      );
    }
  }
}
