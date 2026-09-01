/**
 * @internal Storage engine behind the Sessions capability. One instance per
 * capability, owning the `cf_agents_session_*` tables. All methods assume the
 * caller has settled startup ordering (`lifecycle.ready()` for public API,
 * explicit ownership for the sync aperture).
 *
 * Write economics (PR #2191 doctrine): rows written cost ~1000× rows read on
 * DO SQLite. The message table carries NO secondary indexes — the legacy
 * `assistant_messages` indexes cost two extra billed writes on every append
 * to serve queries that are rare, read-priced scans here. State is derived
 * from existing rows (active leaf = the session's max-rowid row; token totals
 * from stamped per-row estimates), never maintained in counter rows.
 */

import {
  estimateMessageTokens,
  estimateStringTokens
} from "../experimental/memory/utils/tokens";
import {
  AttachmentEngine,
  ATTACHMENT_URL_PREFIX,
  estimatedDataUrlBytes,
  parseAttachmentUrl,
  type StoredAttachment
} from "./attachments";
import {
  SessionMessageNotFoundError,
  SessionSearchDisabledError,
  SessionSerializationError
} from "./errors";
import { overlayMessage, planOverlays } from "./overlays";
import type {
  AttachmentReconstructor,
  HistoryReadOptions,
  RecentHistoryResult,
  SearchResult,
  SessionChangeEvent,
  SessionChangeListener,
  SessionMessage,
  SessionRowStat,
  SessionStats,
  SessionSummary,
  SessionsOptions,
  StoredCompaction
} from "./types";

/**
 * Bounds for each content-hydration query on a history path. Message rows
 * can be up to ~1.8MB each (ROW_MAX_BYTES in agents/chat), so content is
 * fetched in bounded batches: in workerd the SQLite allocator shares the
 * isolate's memory budget with the JS heap and oversized transient result
 * sets surface as SQLITE_NOMEM (#1710). Chunks are bounded by BOTH row count
 * and cumulative stored bytes (sizes come from content-free path stats).
 */
const HISTORY_CONTENT_CHUNK_SIZE = 50;
const HISTORY_CONTENT_CHUNK_BYTES = 4 * 1024 * 1024;

/** Flat token charge for an image attachment (vision-model ballpark). */
export const IMAGE_ATTACHMENT_TOKENS = 1_600;
/** Ceiling for a non-image attachment's bytes/4 token charge. */
export const MAX_ATTACHMENT_TOKENS = 20_000;

/**
 * Heuristic token weight of one attachment so media stops counting as zero
 * (the legacy behavior that let compaction ignore megabytes of images).
 * Model-reported usage remains the authoritative count.
 */
export function estimateAttachmentTokens(
  mediaType: string,
  bytes: number
): number {
  if (mediaType.startsWith("image/")) return IMAGE_ATTACHMENT_TOKENS;
  return Math.min(Math.ceil(bytes / 4), MAX_ATTACHMENT_TOKENS);
}

/** @internal SQL, KV, and telemetry supplied by the capability. */
export interface SessionsCoreIo {
  sql<T>(query: string, params: (string | number | null)[]): T[];
  sqlWrite(query: string, params: (string | number | null)[]): number;
  rawSql(query: string): void;
  putKv(key: string, value: unknown): Promise<void>;
  emit(type: string, payload: Record<string, unknown>): void;
}

/** Per-session O(1)-maintained aggregates over the active branch path. */
type StatsCache = {
  leafId: string | null;
  pathIds: string[];
  pathIdSet: Set<string>;
  rawTokens: number;
  rawBytes: number;
  attachmentBytes: number;
  /** −(covered span tokens) + (summary tokens) for applicable overlays. */
  overlayAdjustment: number;
};

/** Gate invoked between a durable append and its change-feed dispatch. */
export type AppendGate = (
  stats: SessionStats
) => Promise<{ compacted: boolean }>;

const LEGACY_TOMBSTONE_SUFFIX = "__lifted_v1";
const LEGACY_REGISTRY_KV_KEY = "cf_agents:sessions_legacy_registry";

export class SessionsCore {
  readonly io: SessionsCoreIo;
  readonly attachments: AttachmentEngine;
  readonly #searchIndexing: boolean;
  readonly #reservedMetadataKeys: readonly string[];
  #tablesEnsured = false;

  readonly #listeners = new Set<SessionChangeListener>();
  /** Active-leaf cache per session: undefined = cold, null = empty session. */
  readonly #leafCache = new Map<string, string | null>();
  readonly #statsCache = new Map<string, StatsCache>();

  constructor(options: SessionsOptions, io: SessionsCoreIo) {
    this.io = io;
    this.#searchIndexing = options.searchIndexing ?? false;
    this.#reservedMetadataKeys = options.reservedMetadataKeys ?? [];
    this.attachments = new AttachmentEngine(options.attachments, {
      sql: (query, params) => this.io.sql(query, params),
      sqlWrite: (query, params) => this.io.sqlWrite(query, params),
      emit: (type, payload) => this.io.emit(type, payload)
    });
  }

  get searchIndexing(): boolean {
    return this.#searchIndexing;
  }

  // ── Schema ───────────────────────────────────────────────────────────────

  ensureTables(): void {
    if (this.#tablesEnsured) return;
    this.io.rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
    this.io.rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_session_compactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL,
        from_message_id TEXT NOT NULL,
        to_message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.io.rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_session_attachments (
        hash TEXT NOT NULL,
        message_id TEXT NOT NULL,
        part_index INTEGER NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        filename TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (hash, message_id, part_index)
      )
    `);
    this.io.rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_session_config (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      )
    `);
    // Created unconditionally so migration lifts and later flag flips work;
    // maintained on writes only when `searchIndexing` is on.
    this.io.rawSql(`
      CREATE VIRTUAL TABLE IF NOT EXISTS cf_agents_session_fts
      USING fts5(id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content, tokenize='porter unicode61')
    `);
    this.#tablesEnsured = true;
  }

  /**
   * One-time lift of the legacy `assistant_*` tables (pure SQL — SQLite
   * streams internally, no JS materialization) followed by a RENAME to
   * `*__lifted_v1` tombstones. A follow-up release drops the tombstones;
   * until then a manual rollback can rename them back.
   */
  async migrateLegacy(): Promise<void> {
    const legacy = (name: string): boolean =>
      this.io.sql<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        [name]
      ).length > 0;
    const tombstone = (name: string): void => {
      if (!legacy(name) || legacy(`${name}${LEGACY_TOMBSTONE_SUFFIX}`)) return;
      this.io.rawSql(
        `ALTER TABLE ${name} RENAME TO ${name}${LEGACY_TOMBSTONE_SUFFIX}`
      );
    };

    if (legacy("assistant_messages")) {
      this.io.rawSql(`
        INSERT OR IGNORE INTO cf_agents_session_messages
          (id, session_id, parent_id, role, content, token_estimate, created_at)
        SELECT id, session_id, parent_id, role, content,
          CAST(LENGTH(CAST(content AS BLOB)) / 4 AS INTEGER),
          COALESCE(CAST(strftime('%s', created_at) AS INTEGER), 0) * 1000
        FROM assistant_messages ORDER BY created_at ASC, rowid ASC
      `);
    }
    if (legacy("assistant_compactions")) {
      this.io.rawSql(`
        INSERT OR IGNORE INTO cf_agents_session_compactions
          (id, session_id, summary, from_message_id, to_message_id, created_at)
        SELECT id, session_id, summary, from_message_id, to_message_id,
          COALESCE(CAST(strftime('%s', created_at) AS INTEGER), 0) * 1000
        FROM assistant_compactions ORDER BY created_at ASC, rowid ASC
      `);
    }
    if (legacy("assistant_config")) {
      this.io.rawSql(`
        INSERT OR IGNORE INTO cf_agents_session_config (session_id, key, value)
        SELECT session_id, key, value FROM assistant_config
      `);
    }
    if (legacy("assistant_sessions")) {
      // The SessionManager registry is retired; snapshot its rows to KV so
      // nothing is lost, then tombstone the table with the rest.
      const rows = this.io.sql<Record<string, unknown>>(
        "SELECT * FROM assistant_sessions",
        []
      );
      if (rows.length > 0) {
        await this.io.putKv(LEGACY_REGISTRY_KV_KEY, rows);
      }
    }
    if (this.#searchIndexing && legacy("assistant_fts")) {
      const existing = this.io.sql<{ n: number }>(
        "SELECT COUNT(*) AS n FROM cf_agents_session_fts",
        []
      );
      if ((existing[0]?.n ?? 0) === 0) {
        this.io.rawSql(`
          INSERT INTO cf_agents_session_fts (id, session_id, role, content)
          SELECT id, session_id, role, content FROM assistant_fts
        `);
      }
    }

    tombstone("assistant_messages");
    tombstone("assistant_compactions");
    tombstone("assistant_config");
    tombstone("assistant_sessions");
    tombstone("assistant_fts");
  }

  // ── Change feed ──────────────────────────────────────────────────────────

  subscribe(listener: SessionChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async notify(event: SessionChangeEvent): Promise<void> {
    for (const listener of this.#listeners) {
      await listener(event);
    }
  }

  /** Fire-and-forget dispatch for sync-aperture writes. */
  notifyDetached(event: SessionChangeEvent): void {
    void this.notify(event).catch((error) => {
      console.warn(
        `[Sessions] change listener failed for aperture write: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  getMessageRaw(sessionId: string, id: string): SessionMessage | null {
    const rows = this.io.sql<{ content: string }>(
      "SELECT content FROM cf_agents_session_messages WHERE id = ? AND session_id = ?",
      [id, sessionId]
    );
    return rows.length > 0 ? this.#parse(rows[0].content) : null;
  }

  async getMessage(
    sessionId: string,
    id: string,
    reconstructor: AttachmentReconstructor | null
  ): Promise<SessionMessage | null> {
    const message = this.getMessageRaw(sessionId, id);
    if (!message) return null;
    return this.attachments.materialize(sessionId, message, reconstructor);
  }

  latestLeafId(sessionId: string): string | null {
    const cached = this.#leafCache.get(sessionId);
    if (cached !== undefined) return cached;
    // The most recent append is always the active tip: children insert after
    // their parents, so the session's max-rowid row is provably childless,
    // and every write path maintains this cache in place. The capability is
    // the only writer of its tables, so no self-heal validation is needed.
    const rows = this.io.sql<{ id: string }>(
      "SELECT id FROM cf_agents_session_messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
      [sessionId]
    );
    const leafId = rows[0]?.id ?? null;
    this.#leafCache.set(sessionId, leafId);
    return leafId;
  }

  #resolveLeafId(sessionId: string, leafId?: string | null): string | null {
    if (leafId) {
      const rows = this.io.sql<{ id: string }>(
        "SELECT id FROM cf_agents_session_messages WHERE id = ? AND session_id = ?",
        [leafId, sessionId]
      );
      return rows[0]?.id ?? null;
    }
    return this.latestLeafId(sessionId);
  }

  getLatestLeaf(sessionId: string): SessionMessage | null {
    const leafId = this.latestLeafId(sessionId);
    return leafId ? this.getMessageRaw(sessionId, leafId) : null;
  }

  getBranches(sessionId: string, messageId: string): SessionMessage[] {
    const rows = this.io.sql<{ content: string }>(
      `SELECT content FROM cf_agents_session_messages
       WHERE parent_id = ? AND session_id = ?
       ORDER BY created_at ASC, rowid ASC`,
      [messageId, sessionId]
    );
    const result: SessionMessage[] = [];
    for (const row of rows) {
      const message = this.#parse(row.content);
      if (message) result.push(message);
    }
    return result;
  }

  getPathLength(sessionId: string, leafId?: string | null): number {
    const leaf = this.#resolveLeafId(sessionId, leafId);
    if (!leaf) return 0;
    const rows = this.io.sql<{ count: number }>(
      `WITH RECURSIVE path(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM cf_agents_session_messages WHERE id = ?
        UNION ALL
        SELECT m.id, m.parent_id, p.depth + 1 FROM cf_agents_session_messages m
        JOIN path p ON m.id = p.parent_id
        WHERE m.session_id = ? AND p.depth < 10000
      )
      SELECT COUNT(*) AS count FROM path`,
      [leaf, sessionId]
    );
    return rows[0]?.count ?? 0;
  }

  /**
   * The active branch path as content-free (id, role, bytes, tokenEstimate)
   * rows, root → leaf. Recurses over (id, parent_id) only — carrying content
   * through the recursive queue materializes the transcript several times
   * inside SQLite's allocator (#1710).
   */
  pathRowStats(sessionId: string, leafId?: string | null): SessionRowStat[] {
    const leaf = this.#resolveLeafId(sessionId, leafId);
    if (!leaf) return [];
    return this.io.sql<SessionRowStat>(
      `WITH RECURSIVE path(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM cf_agents_session_messages WHERE id = ?
        UNION ALL
        SELECT m.id, m.parent_id, p.depth + 1 FROM cf_agents_session_messages m
        JOIN path p ON m.id = p.parent_id
        WHERE m.session_id = ? AND p.depth < 10000
      )
      SELECT path.id AS id, am.role AS role,
        LENGTH(CAST(am.content AS BLOB)) AS bytes,
        am.token_estimate AS tokenEstimate
      FROM path JOIN cf_agents_session_messages am ON am.id = path.id
      ORDER BY path.depth DESC`,
      [leaf, sessionId]
    );
  }

  /** Split content-free path rows into bounded hydration queries. */
  *#boundedStatsChunks(
    rows: readonly SessionRowStat[]
  ): Generator<readonly SessionRowStat[], void, undefined> {
    let start = 0;
    while (start < rows.length) {
      let end = start;
      let bytes = 0;
      while (end < rows.length && end - start < HISTORY_CONTENT_CHUNK_SIZE) {
        const nextBytes = rows[end].bytes;
        if (end > start && bytes + nextBytes > HISTORY_CONTENT_CHUNK_BYTES) {
          break;
        }
        bytes += nextBytes;
        end++;
      }
      yield rows.slice(start, end);
      start = end;
    }
  }

  /** Fetch and parse one already-bounded content window. */
  #contentByStats(
    sessionId: string,
    rows: readonly SessionRowStat[]
  ): Map<string, SessionMessage> {
    const result = new Map<string, SessionMessage>();
    if (rows.length === 0) return result;
    const fetched = this.io.sql<{ id: string; content: string }>(
      `SELECT id, content FROM cf_agents_session_messages
       WHERE session_id = ?
         AND id IN (SELECT value FROM json_each(?))`,
      [sessionId, JSON.stringify(rows.map((row) => row.id))]
    );
    for (const row of fetched) {
      const message = this.#parse(row.content);
      if (message) result.set(row.id, message);
    }
    return result;
  }

  /** Stream a known path window without retaining earlier content chunks. */
  async *#streamStats(
    sessionId: string,
    stats: readonly SessionRowStat[],
    compactions: readonly StoredCompaction[],
    reconstructor: AttachmentReconstructor | null,
    signal?: AbortSignal
  ): AsyncGenerator<SessionMessage, void, undefined> {
    const spans = planOverlays(
      stats.map((row) => row.id),
      compactions
    );
    const spanByStart = new Map(spans.map((span) => [span.startIndex, span]));

    let index = 0;
    while (index < stats.length) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("History read aborted");
      }
      const span = spanByStart.get(index);
      if (span) {
        yield overlayMessage(span.compaction);
        index = span.endIndex + 1;
        continue;
      }

      let runEnd = index + 1;
      while (runEnd < stats.length && !spanByStart.has(runEnd)) runEnd++;
      for (const chunk of this.#boundedStatsChunks(
        stats.slice(index, runEnd)
      )) {
        const content = this.#contentByStats(sessionId, chunk);
        for (const row of chunk) {
          const message = content.get(row.id);
          if (message) {
            yield await this.attachments.materialize(
              sessionId,
              message,
              reconstructor
            );
          }
        }
        index += chunk.length;
        if (signal?.aborted) {
          throw signal.reason ?? new Error("History read aborted");
        }
      }
    }
  }

  /**
   * Stream the path ending at `leafId` (default: active leaf), root → leaf,
   * compaction overlays collapsed, pointer parts materialized through
   * `reconstructor`. Peak memory is one content chunk plus one message's
   * reconstructed attachments — never the whole transcript.
   */
  async *streamHistory(
    sessionId: string,
    options: HistoryReadOptions,
    reconstructor: AttachmentReconstructor | null
  ): AsyncGenerator<SessionMessage, void, undefined> {
    const stats = this.pathRowStats(sessionId, options.leafId);
    if (stats.length === 0) return;
    yield* this.#streamStats(
      sessionId,
      stats,
      this.getCompactions(sessionId),
      reconstructor,
      options.signal
    );
  }

  async getHistory(
    sessionId: string,
    options: HistoryReadOptions,
    reconstructor: AttachmentReconstructor | null
  ): Promise<SessionMessage[]> {
    const messages: SessionMessage[] = [];
    for await (const message of this.streamHistory(
      sessionId,
      options,
      reconstructor
    )) {
      messages.push(message);
    }
    return messages;
  }

  /**
   * Byte-budgeted read of the most recent messages on the active branch
   * path — the longest suffix fitting `maxContentBytes`, floored at
   * `minRecentMessages` rows. Overlays whose anchors fall outside the
   * window are skipped, showing the raw recent messages (the intended
   * degraded view).
   */
  async getRecentHistory(
    sessionId: string,
    maxContentBytes: number,
    minRecentMessages: number,
    reconstructor: AttachmentReconstructor | null,
    leafId?: string | null
  ): Promise<RecentHistoryResult> {
    const stats = this.pathRowStats(sessionId, leafId);
    if (stats.length === 0) {
      return { messages: [], truncated: false, totalContentBytes: 0 };
    }
    const totalContentBytes = stats.reduce((sum, row) => sum + row.bytes, 0);
    const minRecent = Math.max(1, Math.floor(minRecentMessages));
    let start = stats.length - 1;
    let used = stats[start]?.bytes ?? 0;
    while (
      start > 0 &&
      (stats.length - start < minRecent ||
        used + stats[start - 1].bytes <= maxContentBytes)
    ) {
      start--;
      used += stats[start].bytes;
    }

    const window = stats.slice(start);
    const messages: SessionMessage[] = [];
    for await (const message of this.#streamStats(
      sessionId,
      window,
      this.getCompactions(sessionId),
      reconstructor
    )) {
      messages.push(message);
    }
    return { messages, truncated: start > 0, totalContentBytes };
  }

  listSessions(): SessionSummary[] {
    return this.io
      .sql<{
        session_id: string;
        messageCount: number;
        lastMessageAt: number;
      }>(
        `SELECT session_id, COUNT(*) AS messageCount, MAX(created_at) AS lastMessageAt
       FROM cf_agents_session_messages GROUP BY session_id ORDER BY lastMessageAt DESC`,
        []
      )
      .map((row) => ({
        sessionId: row.session_id,
        messageCount: row.messageCount,
        lastMessageAt: row.lastMessageAt
      }));
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  stats(sessionId: string): SessionStats {
    const cache = this.#deriveStats(sessionId);
    return {
      sessionId,
      tokenEstimate: Math.max(
        0,
        Math.ceil(cache.rawTokens + cache.overlayAdjustment)
      ),
      totalContentBytes: cache.rawBytes,
      attachmentBytes: cache.attachmentBytes,
      pathLength: cache.pathIds.length
    };
  }

  #deriveStats(sessionId: string): StatsCache {
    const cached = this.#statsCache.get(sessionId);
    if (cached) return cached;
    const stats = this.pathRowStats(sessionId);
    const pathIds = stats.map((row) => row.id);
    const compactions = this.getCompactions(sessionId);
    const spans = planOverlays(pathIds, compactions);
    let overlayAdjustment = 0;
    for (const span of spans) {
      for (let i = span.startIndex; i <= span.endIndex; i++) {
        overlayAdjustment -= stats[i].tokenEstimate;
      }
      overlayAdjustment += estimateStringTokens(span.compaction.summary);
    }
    let attachmentBytes = 0;
    if (pathIds.length > 0) {
      const rows = this.io.sql<{ total: number | null }>(
        `SELECT SUM(bytes) AS total FROM cf_agents_session_attachments
         WHERE session_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
        [sessionId, JSON.stringify(pathIds)]
      );
      attachmentBytes = rows[0]?.total ?? 0;
    }
    const cache: StatsCache = {
      leafId: pathIds.at(-1) ?? null,
      pathIds,
      pathIdSet: new Set(pathIds),
      rawTokens: stats.reduce((sum, row) => sum + row.tokenEstimate, 0),
      rawBytes: stats.reduce((sum, row) => sum + row.bytes, 0),
      attachmentBytes,
      overlayAdjustment
    };
    this.#statsCache.set(sessionId, cache);
    return cache;
  }

  invalidateStats(sessionId: string): void {
    this.#statsCache.delete(sessionId);
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  #serialize(message: SessionMessage): string {
    let json: string | undefined;
    try {
      json = JSON.stringify(message);
    } catch (error) {
      throw new SessionSerializationError(
        `message "${message.id}"`,
        error instanceof Error ? error.message : String(error)
      );
    }
    if (json === undefined) {
      throw new SessionSerializationError(
        `message "${message.id}"`,
        "message has no JSON representation"
      );
    }
    return json;
  }

  stripReservedMetadata(message: SessionMessage): SessionMessage {
    if (this.#reservedMetadataKeys.length === 0 || !message.metadata) {
      return message;
    }
    const metadata = { ...message.metadata };
    let changed = false;
    for (const key of this.#reservedMetadataKeys) {
      if (key in metadata) {
        delete metadata[key];
        changed = true;
      }
    }
    if (!changed) return message;
    return Object.keys(metadata).length > 0
      ? { ...message, metadata }
      : (() => {
          const { metadata: _dropped, ...rest } = message;
          return rest as SessionMessage;
        })();
  }

  /** Stamped row estimate: part heuristic plus attachment weights. */
  estimateRowTokens(
    message: SessionMessage,
    extracted: readonly StoredAttachment[]
  ): number {
    let tokens = estimateMessageTokens([message]);
    const extractedByHash = new Map(extracted.map((a) => [a.hash, a]));
    for (const part of message.parts) {
      if (part.type !== "file") continue;
      const hash = parseAttachmentUrl(part.url);
      if (hash) {
        const record = extractedByHash.get(hash);
        const bytes =
          record?.bytes ??
          this.io.sql<{ bytes: number }>(
            "SELECT bytes FROM cf_agents_session_attachments WHERE hash = ? LIMIT 1",
            [hash]
          )[0]?.bytes ??
          0;
        tokens += estimateAttachmentTokens(
          record?.mediaType ?? part.mediaType ?? "application/octet-stream",
          bytes
        );
      } else if (typeof part.url === "string" && part.url.startsWith("data:")) {
        tokens += estimateAttachmentTokens(
          part.mediaType ?? "application/octet-stream",
          estimatedDataUrlBytes(part.url)
        );
      }
    }
    return tokens;
  }

  /**
   * Durable append. The caller has already sanitized, capped, and extracted
   * attachments (`extracted`); everything here down to the reference rows is
   * synchronous — one atomic commit. No awaits or user code may creep
   * between the existence check and the final write: the atomicity lives in
   * the threading model.
   */
  append(
    sessionId: string,
    message: SessionMessage,
    parentId: string | null | undefined,
    extracted: readonly StoredAttachment[]
  ): { inserted: boolean; parentId: string | null } {
    const existing = this.io.sql<{ id: string }>(
      "SELECT id FROM cf_agents_session_messages WHERE id = ? AND session_id = ?",
      [message.id, sessionId]
    );
    if (existing.length > 0) {
      return { inserted: false, parentId: null };
    }

    // `undefined` → auto-attach to the latest leaf; `null` → root; string →
    // validated parent (falls back to root outside this session).
    let parent =
      parentId !== undefined ? parentId : this.latestLeafId(sessionId);
    if (parent) {
      const valid = this.io.sql<{ id: string }>(
        "SELECT id FROM cf_agents_session_messages WHERE id = ? AND session_id = ?",
        [parent, sessionId]
      );
      if (valid.length === 0) parent = null;
    }

    const json = this.#serialize(message);
    const tokenEstimate = this.estimateRowTokens(message, extracted);
    const now = Date.now();
    this.io.sqlWrite(
      `INSERT INTO cf_agents_session_messages
        (id, session_id, parent_id, role, content, token_estimate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [message.id, sessionId, parent, message.role, json, tokenEstimate, now]
    );
    if (this.#searchIndexing) this.#indexFts(sessionId, message);
    const attachmentBytes = this.attachments.recordReferences(
      sessionId,
      message,
      extracted,
      now
    );

    // The freshly inserted row is the most recent childless node, so it is
    // now the latest leaf — true even for an explicit-parent branch append.
    const previousLeaf = this.#leafCache.get(sessionId);
    this.#leafCache.set(sessionId, message.id);

    const cache = this.#statsCache.get(sessionId);
    if (cache) {
      if (parent === cache.leafId && previousLeaf === cache.leafId) {
        // Linear append to the cached tip: O(1) maintenance.
        cache.leafId = message.id;
        cache.pathIds.push(message.id);
        cache.pathIdSet.add(message.id);
        cache.rawTokens += tokenEstimate;
        cache.rawBytes += new TextEncoder().encode(json).byteLength;
        cache.attachmentBytes += attachmentBytes;
      } else {
        // Branch append or unknown topology: re-derive lazily.
        this.#statsCache.delete(sessionId);
      }
    }
    this.io.emit("session:message:appended", {
      sessionId,
      messageId: message.id,
      tokenEstimate
    });
    return { inserted: true, parentId: parent };
  }

  /**
   * Durable update of an existing row. Throws
   * {@link SessionMessageNotFoundError} when the id is absent.
   */
  update(
    sessionId: string,
    message: SessionMessage,
    extracted: readonly StoredAttachment[]
  ): Promise<void> {
    const oldRows = this.io.sql<{
      token_estimate: number;
      content: string;
    }>(
      "SELECT token_estimate, content FROM cf_agents_session_messages WHERE id = ? AND session_id = ?",
      [message.id, sessionId]
    );
    if (oldRows.length === 0) {
      throw new SessionMessageNotFoundError(sessionId, message.id);
    }
    const old = oldRows[0];
    const json = this.#serialize(message);
    const tokenEstimate = this.estimateRowTokens(message, extracted);
    this.io.sqlWrite(
      `UPDATE cf_agents_session_messages
       SET role = ?, content = ?, token_estimate = ?
       WHERE id = ? AND session_id = ?`,
      [message.role, json, tokenEstimate, message.id, sessionId]
    );
    if (this.#searchIndexing) this.#indexFts(sessionId, message);

    const hadPointers = old.content.includes(ATTACHMENT_URL_PREFIX);
    const hasPointers =
      extracted.length > 0 || json.includes(ATTACHMENT_URL_PREFIX);
    let cleanup = Promise.resolve();
    if (hadPointers || hasPointers) {
      // Rebuild reference rows synchronously before store cleanup starts, so
      // the new row can never point at metadata that was removed while an
      // async delete was in flight.
      cleanup = this.attachments.replaceReferences(
        sessionId,
        message,
        extracted,
        Date.now()
      );
      this.#statsCache.delete(sessionId);
    } else {
      const cache = this.#statsCache.get(sessionId);
      if (cache?.pathIdSet.has(message.id)) {
        cache.rawTokens += tokenEstimate - old.token_estimate;
        cache.rawBytes +=
          new TextEncoder().encode(json).byteLength -
          new TextEncoder().encode(old.content).byteLength;
      }
    }
    this.io.emit("session:message:updated", {
      sessionId,
      messageId: message.id
    });
    return cleanup;
  }

  /**
   * Delete rows, SPLICING children to their grandparent so a mid-chain
   * delete never decapitates older history (the legacy provider left a gap
   * that silently truncated the recursive path walk).
   */
  async deleteMessages(sessionId: string, messageIds: string[]): Promise<void> {
    for (const id of messageIds) {
      const rows = this.io.sql<{ parent_id: string | null }>(
        "SELECT parent_id FROM cf_agents_session_messages WHERE id = ? AND session_id = ?",
        [id, sessionId]
      );
      if (rows.length === 0) continue;
      this.io.sqlWrite(
        "UPDATE cf_agents_session_messages SET parent_id = ? WHERE parent_id = ? AND session_id = ?",
        [rows[0].parent_id, id, sessionId]
      );
      this.io.sqlWrite(
        "DELETE FROM cf_agents_session_messages WHERE id = ? AND session_id = ?",
        [id, sessionId]
      );
      this.#deleteFts(sessionId, id);
    }
    await this.attachments.collectGarbage(sessionId, messageIds);
    const cachedLeaf = this.#leafCache.get(sessionId);
    if (typeof cachedLeaf === "string" && messageIds.includes(cachedLeaf)) {
      this.#leafCache.delete(sessionId);
    }
    this.#statsCache.delete(sessionId);
    this.io.emit("session:messages:deleted", {
      sessionId,
      count: messageIds.length
    });
  }

  async clearMessages(sessionId: string): Promise<void> {
    this.io.sqlWrite(
      "DELETE FROM cf_agents_session_messages WHERE session_id = ?",
      [sessionId]
    );
    this.io.sqlWrite(
      "DELETE FROM cf_agents_session_compactions WHERE session_id = ?",
      [sessionId]
    );
    // FTS5 requires delete by rowid.
    const ftsRows = this.io.sql<{ rowid: number }>(
      "SELECT rowid FROM cf_agents_session_fts WHERE session_id = ?",
      [sessionId]
    );
    for (const row of ftsRows) {
      this.io.sqlWrite("DELETE FROM cf_agents_session_fts WHERE rowid = ?", [
        row.rowid
      ]);
    }
    await this.attachments.collectSessionGarbage(sessionId);
    this.#leafCache.set(sessionId, null);
    this.#statsCache.delete(sessionId);
    this.io.emit("session:cleared", { sessionId });
  }

  // ── Compaction storage ───────────────────────────────────────────────────

  addCompaction(
    sessionId: string,
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): StoredCompaction {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.io.sqlWrite(
      `INSERT INTO cf_agents_session_compactions
        (id, session_id, summary, from_message_id, to_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, sessionId, summary, fromMessageId, toMessageId, now]
    );
    this.#statsCache.delete(sessionId);
    this.io.emit("session:compacted", { sessionId, compactionId: id });
    return {
      id,
      summary,
      fromMessageId,
      toMessageId,
      createdAt: new Date(now).toISOString()
    };
  }

  getCompactions(sessionId: string): StoredCompaction[] {
    return this.io
      .sql<{
        id: string;
        summary: string;
        from_message_id: string;
        to_message_id: string;
        created_at: number;
      }>(
        `SELECT * FROM cf_agents_session_compactions
       WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
        [sessionId]
      )
      .map((row) => ({
        id: row.id,
        summary: row.summary,
        fromMessageId: row.from_message_id,
        toMessageId: row.to_message_id,
        createdAt: new Date(row.created_at).toISOString()
      }));
  }

  // ── Search ───────────────────────────────────────────────────────────────

  search(sessionId: string, query: string, limit: number): SearchResult[] {
    if (!this.#searchIndexing) throw new SessionSearchDisabledError();
    // Wrap in double quotes to treat as a literal phrase, escaping any
    // existing double quotes to prevent FTS5 syntax injection.
    const sanitized = `"${query.replace(/"/g, '""')}"`;
    try {
      return this.io
        .sql<{ id: string; role: string; content: string }>(
          `SELECT f.id, f.role, f.content FROM cf_agents_session_fts f
         INNER JOIN cf_agents_session_messages m
           ON m.id = f.id AND m.session_id = f.session_id
         WHERE cf_agents_session_fts MATCH ? AND f.session_id = ?
         ORDER BY rank LIMIT ?`,
          [sanitized, sessionId, limit]
        )
        .map((row) => ({ id: row.id, role: row.role, content: row.content }));
    } catch {
      // Malformed FTS query — return empty results.
      return [];
    }
  }

  #indexFts(sessionId: string, message: SessionMessage): void {
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join(" ");
    // Always delete the old entry first — handles text→no-text transitions.
    this.#deleteFts(sessionId, message.id);
    if (text) {
      this.io.sqlWrite(
        "INSERT INTO cf_agents_session_fts (id, session_id, role, content) VALUES (?, ?, ?, ?)",
        [message.id, sessionId, message.role, text]
      );
    }
  }

  #deleteFts(sessionId: string, id: string): void {
    const rows = this.io.sql<{ rowid: number }>(
      "SELECT rowid FROM cf_agents_session_fts WHERE id = ? AND session_id = ?",
      [id, sessionId]
    );
    for (const row of rows) {
      this.io.sqlWrite("DELETE FROM cf_agents_session_fts WHERE rowid = ?", [
        row.rowid
      ]);
    }
  }

  // ── Fork / import ────────────────────────────────────────────────────────

  /**
   * Copy the path ending at `atMessageId` (default: active leaf) into
   * another session. Rows get fresh ids (the id column is a global PK);
   * blobs are shared — attachment reference rows are copied, bytes never
   * move. Compaction overlays are not copied (their anchors are re-ided).
   */
  fork(
    sessionId: string,
    toSessionId: string,
    atMessageId?: string
  ): { sessionId: string; leafId: string | null } {
    const stats = this.pathRowStats(sessionId, atMessageId ?? null);
    const idMap = new Map<string, string>();
    let previousNewId: string | null = null;
    for (const window of this.#boundedStatsChunks(stats)) {
      const content = this.#contentByStats(sessionId, window);
      for (const row of window) {
        const message = content.get(row.id);
        if (!message) continue;
        const newId = crypto.randomUUID();
        idMap.set(row.id, newId);
        const copied = { ...message, id: newId };
        this.io.sqlWrite(
          `INSERT INTO cf_agents_session_messages
            (id, session_id, parent_id, role, content, token_estimate, created_at)
           SELECT ?, ?, ?, role, ?, token_estimate, created_at
           FROM cf_agents_session_messages WHERE id = ? AND session_id = ?`,
          [
            newId,
            toSessionId,
            previousNewId,
            this.#serialize(copied),
            row.id,
            sessionId
          ]
        );
        this.io.sqlWrite(
          `INSERT OR IGNORE INTO cf_agents_session_attachments
            (hash, message_id, part_index, session_id, path, media_type, bytes, filename, created_at)
           SELECT hash, ?, part_index, ?, path, media_type, bytes, filename, created_at
           FROM cf_agents_session_attachments WHERE message_id = ? AND session_id = ?`,
          [newId, toSessionId, row.id, sessionId]
        );
        if (this.#searchIndexing) this.#indexFts(toSessionId, copied);
        previousNewId = newId;
      }
    }
    this.#leafCache.set(toSessionId, previousNewId);
    this.#statsCache.delete(toSessionId);
    return { sessionId: toSessionId, leafId: previousNewId };
  }

  /**
   * Import one historical message verbatim (migrations, cross-DO moves):
   * explicit parent and timestamp, stamped estimate, no change-feed events.
   */
  importMessage(
    sessionId: string,
    message: SessionMessage,
    options: { parentId: string | null; createdAt: number }
  ): void {
    const json = this.#serialize(message);
    const inserted = this.io.sqlWrite(
      `INSERT OR IGNORE INTO cf_agents_session_messages
        (id, session_id, parent_id, role, content, token_estimate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        sessionId,
        options.parentId,
        message.role,
        json,
        this.estimateRowTokens(message, []),
        options.createdAt
      ]
    );
    if (inserted === 0) return;
    if (this.#searchIndexing) this.#indexFts(sessionId, message);
    this.attachments.recordReferences(
      sessionId,
      message,
      [],
      options.createdAt
    );
    this.#leafCache.set(sessionId, message.id);
    this.#statsCache.delete(sessionId);
  }

  /** Every stored row of one session in insertion order (sync aperture). */
  readAllRows(
    sessionId: string
  ): { id: string; parentId: string | null; message: SessionMessage }[] {
    const rows = this.io.sql<{
      id: string;
      parent_id: string | null;
      content: string;
    }>(
      "SELECT id, parent_id, content FROM cf_agents_session_messages WHERE session_id = ? ORDER BY rowid ASC",
      [sessionId]
    );
    const result: {
      id: string;
      parentId: string | null;
      message: SessionMessage;
    }[] = [];
    for (const row of rows) {
      const message = this.#parse(row.content);
      if (message) {
        result.push({ id: row.id, parentId: row.parent_id, message });
      }
    }
    return result;
  }

  // ── Config (legacy lift) ─────────────────────────────────────────────────

  getConfigValue(sessionId: string, key: string): string | null {
    const rows = this.io.sql<{ value: string }>(
      "SELECT value FROM cf_agents_session_config WHERE session_id = ? AND key = ?",
      [sessionId, key]
    );
    return rows[0]?.value ?? null;
  }

  deleteConfigValue(sessionId: string, key: string): void {
    this.io.sqlWrite(
      "DELETE FROM cf_agents_session_config WHERE session_id = ? AND key = ?",
      [sessionId, key]
    );
  }

  // ── Parsing ──────────────────────────────────────────────────────────────

  #parse(json: string): SessionMessage | null {
    try {
      const message = JSON.parse(json);
      if (
        typeof message?.id === "string" &&
        typeof message?.role === "string" &&
        Array.isArray(message?.parts)
      ) {
        return message;
      }
    } catch {
      /* skip unparseable rows, matching legacy behavior */
    }
    return null;
  }
}
