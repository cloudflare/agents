/**
 * Durable conversation history for Lifecycle Objects. `Sessions` owns the
 * `cf_agents_session_*` tables: tree-structured messages (branch
 * regeneration, latest-leaf paths), compaction overlays, and opt-in FTS
 * search. A message larger than one SQLite row is split across continuation
 * rows and reassembled on read, so nothing is ever too large to store.
 *
 * Sessions consumes only the standard capability services — storage and
 * events. It needs no alarm, so it also works on facets (facets have
 * isolated SQLite but no independent alarm slot).
 *
 * @experimental The API surface may change before stabilizing.
 */

import { LifecycleCapability } from "../lifecycle/capability";
import { SqlError } from "../sql-error";
import { SessionsCore } from "./core";
import { Session } from "./handle";
import type { SqlParam } from "./io";
import type {
  SessionChangeListener,
  SessionSummary,
  SessionsOptions
} from "./types";

const SESSIONS_SCHEMA_VERSION_KEY = "cf_agents:sessions_schema_version";
const CURRENT_SESSIONS_SCHEMA_VERSION = 1;

/** The default session id used when `session()` is called without one. */
export const DEFAULT_SESSION_ID = "";

/**
 * Durable conversation history for a Lifecycle Object.
 *
 * `session()` returns a per-session handle for reads (streamed, byte
 * budgeted), writes (sanitized, payload-offloaded), branch navigation, and
 * compaction overlays. `subscribe()` is the change feed a cache-owning host
 * mirrors.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Sessions extends LifecycleCapability {
  readonly #options: SessionsOptions;
  #core: SessionsCore | undefined;
  readonly #handles = new Map<string, Session>();

  constructor(options: SessionsOptions = {}) {
    super("sessions");
    this.#options = options;
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────────

  /** Migrate session storage during Lifecycle startup. */
  async onStart(): Promise<void> {
    const storage = this.lifecycle.storage;
    const version =
      (await storage.get<number>(SESSIONS_SCHEMA_VERSION_KEY)) ?? 0;
    const core = this.#getCore();
    core.ensureTables();
    if (version < CURRENT_SESSIONS_SCHEMA_VERSION) {
      // Stamp the version only when every legacy source was fully lifted. A
      // partial migration that recorded success would never be retried, and
      // the rows it left behind would stay unreachable through the new API
      // forever. The lift is idempotent, so retrying costs reads and nothing
      // else.
      if (core.migrateLegacy()) {
        await storage.put(
          SESSIONS_SCHEMA_VERSION_KEY,
          CURRENT_SESSIONS_SCHEMA_VERSION
        );
      }
    }
  }

  // ── Surface ──────────────────────────────────────────────────────────────

  /**
   * The handle for one session. The default (empty) id is the primary path:
   * in the one-object-per-conversation model a Durable Object holds exactly
   * one session. Handles are cached, so per-session configuration (the
   * compaction trigger) survives repeated calls.
   */
  session(sessionId: string = DEFAULT_SESSION_ID): Session {
    const existing = this.#handles.get(sessionId);
    if (existing) return existing;
    const handle = new Session(
      sessionId,
      () => this.#getCore(),
      () => this.lifecycle.ready()
    );
    this.#handles.set(sessionId, handle);
    return handle;
  }

  /** Session summaries derived from message rows — no registry table. */
  async listSessions(): Promise<SessionSummary[]> {
    await this.lifecycle.ready();
    return this.#getCore().listSessions();
  }

  /**
   * Subscribe to the change feed: synchronous ordered dispatch after every
   * durable write, with the stored message. The host cache mirror lives here;
   * telemetry additionally flows through capability events.
   */
  subscribe(listener: SessionChangeListener): () => void {
    return this.#getCore().subscribe(listener);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  #getCore(): SessionsCore {
    if (this.#core) return this.#core;
    const lifecycle = this.lifecycle;
    const exec = (query: string, params: SqlParam[]) => {
      try {
        return lifecycle.storage.sql.exec(query, ...params);
      } catch (cause) {
        throw new SqlError(query, cause);
      }
    };
    this.#core = new SessionsCore(this.#options, {
      // SAFETY: Sessions queries select from its own schema; T describes the
      // projected columns of the accompanying query text.
      sql: <T>(query: string, params: SqlParam[]) =>
        [...exec(query, params)] as T[],
      sqlWrite: (query, params) => exec(query, params).rowsWritten,
      transaction: (fn) => lifecycle.storage.transactionSync(fn),
      emit: (type, payload) => lifecycle.events.emit(type, payload)
    });
    return this.#core;
  }
}
