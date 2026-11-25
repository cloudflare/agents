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
  /** The KV key of this instance's schema version. */
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
    const storage = this.lifecycle.storage;
    const version = (await storage.get<number>(this.#schemaKey)) ?? 0;
    this.#core.ensureTables();
    if (this.instanceName !== undefined) {
      // A named instance never held released rows: nothing to lift or
      // rebuild. Its tables start at the current version.
      if (version < CURRENT_SESSIONS_SCHEMA_VERSION) {
        await storage.put(this.#schemaKey, CURRENT_SESSIONS_SCHEMA_VERSION);
      }
      return;
    }
    if (version < CURRENT_SESSIONS_SCHEMA_VERSION) {
      // Stamp the version only when every legacy source was fully lifted. A
      // partial migration that recorded success would never be retried, and
      // the rows it left behind would stay unreachable through the new API
      // forever. The lift is idempotent, so retrying costs reads and nothing
      // else. The compactions rebuild runs after it, so lifted overlays are
      // rebuilt too; it is a no-op once done.
      const lifted = version >= 1 || this.#core.migrateLegacy();
      this.#core.rebuildCompactions();
      if (lifted) {
        await storage.put(this.#schemaKey, CURRENT_SESSIONS_SCHEMA_VERSION);
      }
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
