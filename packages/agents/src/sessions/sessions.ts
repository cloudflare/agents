/**
 * Durable conversation history for Lifecycle Objects. `Sessions` owns the
 * `cf_agents_session_*` tables: tree-structured messages (branch
 * regeneration, latest-leaf paths), compaction overlays, opt-in FTS search,
 * and content-addressed attachment offload behind a structural store seam.
 *
 * Sessions consumes only the standard capability services — storage and
 * events. It needs no alarm, so it also works on facets (facets have
 * isolated SQLite but no independent alarm slot).
 *
 * @experimental The API surface may change before stabilizing.
 */

import { LifecycleCapability } from "../lifecycle/capability";
import { SqlError } from "../sql-error";
import { SessionAttachmentMissingError } from "./errors";
import { parseAttachmentUrl, type StoredAttachment } from "./attachments";
import { SessionsCore } from "./core";
import { Session } from "./handle";
import type {
  SessionChangeListener,
  SessionMessage,
  SessionMessagePart,
  SessionSummary,
  SessionsOptions
} from "./types";

const SESSIONS_SCHEMA_VERSION_KEY = "cf_agents:sessions_schema_version";
const CURRENT_SESSIONS_SCHEMA_VERSION = 1;

/** The default session id used when `session()` is called without one. */
export const DEFAULT_SESSION_ID = "";

/**
 * @internal Synchronous operations returned by
 * {@link Sessions.__DO_NOT_USE_WILL_BREAK__sync}. For same-isolate
 * first-party machinery only (host constructor hydration, legacy lifts,
 * pre-start recovery); every method bypasses `lifecycle.ready()`, so the
 * caller owns startup ordering. Writes skip the async attachment offload
 * (stored verbatim, row-capped upstream) and dispatch change-feed events
 * without awaiting them.
 */
export interface SessionsSyncInternal {
  /** Idempotent DDL — safe to call before the Lifecycle starts. */
  ensureTables(): void;
  getMessage(sessionId: string, id: string): SessionMessage | null;
  /** Insert if absent; returns whether a row was inserted. */
  appendMessage(
    sessionId: string,
    message: SessionMessage,
    parentId?: string | null
  ): boolean;
  updateMessage(sessionId: string, message: SessionMessage): void;
  latestLeafId(sessionId: string): string | null;
  /** Every stored row of one session in insertion order. */
  readAll(
    sessionId: string
  ): { id: string; parentId: string | null; message: SessionMessage }[];
  /**
   * Import one historical message verbatim (migrations, cross-DO moves):
   * explicit parent and timestamp, no change-feed events.
   */
  importMessage(
    sessionId: string,
    message: SessionMessage,
    options: { parentId: string | null; createdAt: number }
  ): void;
  /** Read one lifted legacy config value (`assistant_config` home). */
  getConfigValue(sessionId: string, key: string): string | null;
  deleteConfigValue(sessionId: string, key: string): void;
}

/** Capability-level attachment surface (content-addressed, session-free). */
export interface SessionsAttachments {
  /**
   * Store one payload content-addressed and get back a pointer part ready
   * to place in a message, plus its record. Accepts a stream — the real
   * "streaming in" path for uploads.
   */
  put(
    data: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | string,
    options: { mediaType: string; filename?: string }
  ): Promise<{ part: SessionMessagePart; attachment: StoredAttachment }>;
  /** Return metadata for one stored payload, when known. */
  get(hashOrUrl: string): Promise<StoredAttachment | null>;
  /** Open one stored payload by pointer hash or `attachment:` URL. */
  open(hashOrUrl: string): Promise<ReadableStream<Uint8Array>>;
}

/**
 * Durable conversation history for a Lifecycle Object.
 *
 * `session()` returns a per-session handle for reads (streamed, byte
 * budgeted), writes (sanitized, row-capped, attachment-offloaded), branch
 * navigation, and compaction overlays. `subscribe()` is the change feed a
 * cache-owning host mirrors.
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
    if (version < CURRENT_SESSIONS_SCHEMA_VERSION) {
      const core = this.#getCore();
      core.ensureTables();
      await core.migrateLegacy();
      await storage.put(
        SESSIONS_SCHEMA_VERSION_KEY,
        CURRENT_SESSIONS_SCHEMA_VERSION
      );
    } else {
      this.#getCore().ensureTables();
    }
  }

  // ── Surface ──────────────────────────────────────────────────────────────

  /**
   * The handle for one session. The default (empty) id is the primary path:
   * in the one-DO-per-conversation model a Durable Object holds exactly one
   * session. Handles are cached — per-session configuration (compaction
   * trigger, context) survives repeated calls.
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
   * durable write, with the stored message. The host cache mirror lives
   * here; telemetry additionally flows through capability events.
   */
  subscribe(listener: SessionChangeListener): () => void {
    return this.#getCore().subscribe(listener);
  }

  /** Content-addressed attachment storage shared by every session. */
  get attachments(): SessionsAttachments {
    const core = this.#getCore();
    const resolveHash = (hashOrUrl: string): string => {
      const hash = parseAttachmentUrl(hashOrUrl) ?? hashOrUrl;
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        throw new SessionAttachmentMissingError(hash, hashOrUrl);
      }
      return hash;
    };
    return {
      put: async (data, options) => {
        await this.lifecycle.ready();
        return core.attachments.put(data, options);
      },
      get: async (hashOrUrl) => {
        await this.lifecycle.ready();
        return core.attachments.get(resolveHash(hashOrUrl));
      },
      open: async (hashOrUrl) => {
        await this.lifecycle.ready();
        return core.attachments.open(resolveHash(hashOrUrl));
      }
    };
  }

  // ── Internal sync aperture ───────────────────────────────────────────────

  /**
   * @internal Synchronous storage operations for same-isolate first-party
   * machinery. Bypasses `lifecycle.ready()`: the caller owns startup
   * ordering. Will break without notice; never use from application code.
   */
  __DO_NOT_USE_WILL_BREAK__sync(): SessionsSyncInternal {
    const core = this.#getCore();
    return {
      ensureTables: () => core.ensureTables(),
      getMessage: (sessionId, id) => core.getMessageRaw(sessionId, id),
      appendMessage: (sessionId, message, parentId) => {
        const prepared = core.stripReservedMetadata(message);
        const { inserted } = core.append(sessionId, prepared, parentId, []);
        core.notifyDetached({
          type: "append",
          sessionId,
          message: prepared,
          parentId,
          inserted
        });
        return inserted;
      },
      updateMessage: (sessionId, message) => {
        core.update(sessionId, message, []);
        core.notifyDetached({ type: "update", sessionId, message });
      },
      latestLeafId: (sessionId) => core.latestLeafId(sessionId),
      readAll: (sessionId) => core.readAllRows(sessionId),
      importMessage: (sessionId, message, options) =>
        core.importMessage(sessionId, message, options),
      getConfigValue: (sessionId, key) => core.getConfigValue(sessionId, key),
      deleteConfigValue: (sessionId, key) =>
        core.deleteConfigValue(sessionId, key)
    };
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  #getCore(): SessionsCore {
    if (this.#core) return this.#core;
    const lifecycle = this.lifecycle;
    const exec = (query: string, params: (string | number | null)[]) => {
      try {
        return lifecycle.storage.sql.exec(query, ...params);
      } catch (cause) {
        throw new SqlError(query, cause);
      }
    };
    this.#core = new SessionsCore(this.#options, {
      // SAFETY: Sessions queries select from its own schema; T describes the
      // projected columns of the accompanying query text.
      sql: <T>(query: string, params: (string | number | null)[]) =>
        [...exec(query, params)] as T[],
      sqlWrite: (query, params) => exec(query, params).rowsWritten,
      rawSql: (query) => {
        try {
          lifecycle.storage.sql.exec(query);
        } catch (cause) {
          throw new SqlError(query, cause);
        }
      },
      putKv: (key, value) => lifecycle.storage.put(key, value),
      emit: (type, payload) => lifecycle.events.emit(type, payload)
    });
    return this.#core;
  }
}
