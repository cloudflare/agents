/**
 * Durable conversation history for Lifecycle Objects. `Sessions` owns the
 * `cf_agents_session_*` tables: tree-structured messages (branch
 * regeneration, latest-leaf paths), compaction overlays, and full-text
 * search whose index is built on first use. A message larger than one
 * SQLite row is split across continuation rows and reassembled on read, so
 * nothing is ever too large to store.
 *
 * Sessions consumes only the standard capability services — storage and
 * events. It needs no alarm, so it also works on facets (facets have
 * isolated SQLite but no independent alarm slot).
 *
 * @experimental The API surface may change before stabilizing.
 */

import { LifecycleCapability } from "../lifecycle/capability";
import { SqlError } from "../sql-error";
import { SessionsCore, sessionTables } from "./core";
import { Session } from "./handle";
import type { SqlParam } from "./io";
import type { SessionChangeListener, SessionsOptions } from "./types";

/**
 * 1: legacy `assistant_*` tables lifted. 2: compactions keyed by their end,
 * with `resume_id`.
 */
const CURRENT_SESSIONS_SCHEMA_VERSION = 2;

/** Thrown by schema step 1 when a legacy source was not fully lifted. */
const LIFT_INCOMPLETE = Symbol("sessions.liftIncomplete");

/**
 * Durable conversation history for a Lifecycle Object.
 *
 * `session()` returns a per-session handle for reads (streamed, byte
 * budgeted), writes (sanitized, media offloaded), branch navigation, and
 * compaction overlays. `subscribe()` is the change feed a cache-owning host
 * mirrors.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Sessions extends LifecycleCapability {
  readonly #core: SessionsCore;
  readonly #handles = new Map<string, Session>();
  /** The KV key Sessions kept its schema version under before the record. */
  readonly #schemaKey: string;

  constructor(options: SessionsOptions = {}) {
    super("sessions", options.name);
    const store = this.store;
    this.#schemaKey = store.key("sessions_schema_version");
    // Every service is reached lazily, so a handle or a subscription may be
    // taken before `Lifecycle.use()` installs the capability.
    const exec = (query: string, params: SqlParam[]) => {
      try {
        return this.lifecycle.storage.sql.exec(query, ...params);
      } catch (cause) {
        throw new SqlError(query, cause);
      }
    };
    this.#core = new SessionsCore(
      options,
      {
        // SAFETY: Sessions queries select from its own schema; T describes the
        // projected columns of the accompanying query text.
        sql: <T>(query: string, params: SqlParam[]) =>
          [...exec(query, params)] as T[],
        sqlWrite: (query, params) => exec(query, params).rowsWritten,
        transaction: (fn) => this.lifecycle.storage.transactionSync(fn),
        emit: (type, payload) => this.lifecycle.events.emit(type, payload)
      },
      sessionTables(store.table, options.name !== undefined)
    );
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Migrate session storage during Lifecycle startup. */
  async onStart(): Promise<void> {
    this.#core.ensureTables();
    if (this.instanceName !== undefined) {
      // A named instance never held released rows: nothing to lift or
      // rebuild. Its tables start at the current version.
      await this.lifecycle.schema.migrate({
        version: CURRENT_SESSIONS_SCHEMA_VERSION,
        steps: {},
        legacyKey: this.#schemaKey
      });
      return;
    }
    // On the Lifecycle's one schema record; the version Sessions kept under
    // its own key is folded in once. `migrate`, not `migrateSync`: the lift
    // and the rebuild read long spans to verify, and those reads stay
    // outside a transaction (each step opens its own for its writes).
    try {
      await this.lifecycle.schema.migrate({
        version: CURRENT_SESSIONS_SCHEMA_VERSION,
        legacyKey: this.#schemaKey,
        steps: {
          // A lift that left a source behind leaves the version unstamped,
          // so it retries on a later start; the lift is idempotent.
          1: () => {
            if (!this.#core.migrateLegacy()) throw LIFT_INCOMPLETE;
          },
          // A no-op on a table that already has the column.
          2: () => this.#core.rebuildCompactions()
        }
      });
    } catch (error) {
      if (error !== LIFT_INCOMPLETE) throw error;
      // Lifted overlays are rebuilt even while the lift retries.
      this.#core.rebuildCompactions();
    }
    // Not gated on the version: overlays an earlier release wrote (before
    // the rebuild, or after a rollback) get their continuation here.
    this.#core.resolveOverlays();
    // Not gated on the version: a lift that left rows behind retries on
    // every start until the table is gone.
    this.#core.liftLegacyFlatMessages();
  }

  // ── Surface ──────────────────────────────────────────────────────────────

  /**
   * The handle for one session. The default (empty) id is the primary path:
   * in the one-object-per-conversation model a Durable Object holds exactly
   * one session. Handles are cached, so per-session configuration (the
   * compaction trigger) survives repeated calls.
   */
  session(sessionId = ""): Session {
    const existing = this.#handles.get(sessionId);
    if (existing) return existing;
    const handle = new Session(sessionId, this.#core, () =>
      this.lifecycle.ready()
    );
    this.#handles.set(sessionId, handle);
    return handle;
  }

  /**
   * @internal Every session that holds the value `key` (`internal_setConfig`
   * on its handle), with the value: how a first-party module lists the
   * sessions it keeps something for. It reads every config row of the
   * object (the key is `(session_id, key)`), so call it on demand, never on
   * a per-turn or per-request path.
   */
  async internal_configs(
    key: string
  ): Promise<{ sessionId: string; value: string }[]> {
    await this.lifecycle.ready();
    return this.#core.configs(key);
  }

  /**
   * Subscribe to the change feed: ordered dispatch after every durable
   * write, with the stored message. The host cache mirror lives here;
   * telemetry additionally flows through capability events.
   */
  subscribe(listener: SessionChangeListener): () => void {
    return this.#core.subscribe(listener);
  }
}
