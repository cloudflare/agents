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

import { byteLength } from "../chat/sanitize";
import { estimateMessageTokens, estimateStringTokens } from "./tokens";
import {
  AttachmentEngine,
  ATTACHMENT_URL_PREFIX,
  estimatedDataUrlBytes,
  parseAttachmentUrl,
  type StoredAttachment
} from "./attachments";
import type {
  AttachmentSqlParam,
  AttachmentChunkRow
} from "./attachment-storage";
import {
  SessionMessageNotFoundError,
  SessionSearchDisabledError,
  SessionSerializationError
} from "./errors";
import { maxEvictableMediaBytes } from "./eviction";
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
  sql<T>(query: string, params: AttachmentSqlParam[]): T[];
  sqlWrite(query: string, params: AttachmentSqlParam[]): number;
  rawSql(query: string): void;
  transaction<T>(fn: () => T): T;
  chunk(storageId: string, index: number): AttachmentChunkRow | null;
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

export class SessionsCore {
  readonly io: SessionsCoreIo;
  readonly attachments: AttachmentEngine;
  readonly #searchIndexing: boolean;
  readonly #reservedMetadataKeys: readonly string[];
  readonly #missingUpdate: "ignore" | "error";
  #tablesEnsured = false;

  readonly #listeners = new Set<SessionChangeListener>();
  /** Active-leaf cache per session: undefined = cold, null = empty session. */
  readonly #leafCache = new Map<string, string | null>();
  readonly #statsCache = new Map<string, StatsCache>();

  constructor(options: SessionsOptions, io: SessionsCoreIo) {
    this.io = io;
    this.#searchIndexing = options.searchIndexing ?? false;
    this.#reservedMetadataKeys = options.reservedMetadataKeys ?? [];
    this.#missingUpdate = options.missingUpdate ?? "error";
    this.attachments = new AttachmentEngine(options.attachments, {
      sql: (query, params) => this.io.sql(query, params),
      sqlWrite: (query, params) => this.io.sqlWrite(query, params),
      rawSql: (query) => this.io.rawSql(query),
      transaction: (fn) => this.io.transaction(fn),
      chunk: (storageId, index) => this.io.chunk(storageId, index),
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
        media_candidate_bytes INTEGER NOT NULL DEFAULT 0,
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
    this.io.rawSql(`
      CREATE TABLE IF NOT EXISTS cf_agents_context_blocks (
        label TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    if (this.#searchIndexing) this.#ensureFtsTable();
    this.#tablesEnsured = true;
  }

  #ensureFtsTable(): void {
    const exists =
      this.io.sql<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_session_fts'",
        []
      ).length > 0;
    if (exists) return;
    this.io.rawSql(`
      CREATE VIRTUAL TABLE cf_agents_session_fts
      USING fts5(id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content, tokenize='porter unicode61')
    `);
    this.#backfillMissingFtsRows();
  }

  #backfillMissingFtsRows(): void {
    // A host may enable indexing after messages already exist. Backfill in SQL
    // without materializing message JSON in the isolate.
    this.io.rawSql(`
      INSERT INTO cf_agents_session_fts (id, session_id, role, content)
      SELECT m.id, m.session_id, m.role,
        group_concat(json_extract(part.value, '$.text'), ' ')
      FROM cf_agents_session_messages AS m
      JOIN json_each(
        CASE WHEN json_valid(m.content) THEN m.content ELSE '{"parts":[]}' END,
        '$.parts'
      ) AS part
      WHERE json_extract(part.value, '$.type') = 'text'
        AND COALESCE(json_extract(part.value, '$.text'), '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM cf_agents_session_fts AS existing
          WHERE existing.id = m.id AND existing.session_id = m.session_id
        )
      GROUP BY m.id, m.session_id, m.role
    `);
  }

  /**
   * One-time lift of the legacy `assistant_*` tables (pure SQL — SQLite
   * streams internally, no JS materialization) followed by a RENAME to
   * `*__lifted_v1` tombstones. A follow-up release drops the tombstones;
   * until then a manual rollback can rename them back.
   */
  migrateLegacy(): void {
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
          (id, session_id, parent_id, role, content, token_estimate, media_candidate_bytes, created_at)
        SELECT id, session_id, parent_id, role, content,
          CAST(LENGTH(CAST(content AS BLOB)) / 4 AS INTEGER),
          LENGTH(CAST(content AS BLOB)),
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
    if (this.#searchIndexing) this.#backfillMissingFtsRows();
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
    return this.getMessageRecord(sessionId, id)?.message ?? null;
  }

  getMessageRecord(
    sessionId: string,
    id: string
  ): { content: string; message: SessionMessage } | null {
    const rows = this.io.sql<{ content: string }>(
      "SELECT content FROM cf_agents_session_messages WHERE id = ? AND session_id = ?",
      [id, sessionId]
    );
    if (rows.length === 0) return null;
    const message = this.#parse(rows[0].content);
    return message ? { content: rows[0].content, message } : null;
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
        am.token_estimate AS tokenEstimate,
        am.media_candidate_bytes AS mediaCandidateBytes
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

  /**
   * Iterate selected raw path rows in bounded content queries. Internal skill
   * restoration uses this instead of one `getMessageRaw` query per row.
   */
  *rawMessagesByStats(
    sessionId: string,
    stats: readonly SessionRowStat[],
    reverse = false
  ): Generator<SessionMessage, void, undefined> {
    const ordered = reverse ? [...stats].reverse() : stats;
    for (const chunk of this.#boundedStatsChunks(ordered)) {
      const content = this.#contentByStats(sessionId, chunk);
      for (const row of chunk) {
        const message = content.get(row.id);
        if (message) yield message;
      }
    }
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
    if (
      this.#reservedMetadataKeys.length === 0 ||
      typeof message.metadata !== "object" ||
      message.metadata === null ||
      Array.isArray(message.metadata)
    ) {
      return message;
    }
    const metadata: Record<string, unknown> = {
      ...message.metadata
    };
    let changed = false;
    for (const key of this.#reservedMetadataKeys) {
      if (key in metadata) {
        delete metadata[key];
        changed = true;
      }
    }
    if (!changed) return message;
    if (Object.keys(metadata).length > 0) return { ...message, metadata };
    const { metadata: _dropped, ...withoutMetadata } = message;
    return withoutMetadata;
  }

  #mediaCandidateBytesAtWrite(message: SessionMessage): number {
    return maxEvictableMediaBytes(message);
  }

  /** Stamped row estimate: part heuristic plus attachment weights. */
  estimateRowTokens(
    message: SessionMessage,
    extracted: readonly StoredAttachment[]
  ): number {
    let tokens = estimateMessageTokens([message]);
    const extractedByHash = new Map(extracted.map((a) => [a.hash, a]));
    const storedByHash = this.attachments.getMany(
      message.parts.flatMap((part) => {
        const hash = parseAttachmentUrl(part.url);
        return hash && !extractedByHash.has(hash) ? [hash] : [];
      })
    );
    for (const part of message.parts) {
      if (part.type !== "file") continue;
      const hash = parseAttachmentUrl(part.url);
      if (hash) {
        const record = extractedByHash.get(hash) ?? storedByHash.get(hash);
        const bytes = record?.bytes ?? 0;
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
   * attachments (`extracted`). Message, FTS, and reference rows commit in one
   * synchronous SQLite transaction. Blob writes completed before this call;
   * payload cleanup happens after commit.
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

    // `undefined` uses the internally maintained latest leaf and needs no
    // validation read. Caller-supplied IDs remain untrusted and fall back to
    // a root append when they do not belong to this session.
    let parent: string | null;
    if (parentId === undefined) {
      parent = this.latestLeafId(sessionId);
    } else {
      parent = parentId;
      if (parent) {
        const valid = this.io.sql<{ id: string }>(
          "SELECT id FROM cf_agents_session_messages WHERE id = ? AND session_id = ?",
          [parent, sessionId]
        );
        if (valid.length === 0) parent = null;
      }
    }

    const json = this.#serialize(message);
    const tokenEstimate = this.estimateRowTokens(message, extracted);
    const mediaCandidateBytes = this.#mediaCandidateBytesAtWrite(message);
    const now = Date.now();
    let attachmentBytes = 0;
    this.io.transaction(() => {
      this.io.sqlWrite(
        `INSERT INTO cf_agents_session_messages
          (id, session_id, parent_id, role, content, token_estimate, media_candidate_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.id,
          sessionId,
          parent,
          message.role,
          json,
          tokenEstimate,
          mediaCandidateBytes,
          now
        ]
      );
      if (this.#searchIndexing) this.#indexFts(sessionId, message, false);
      attachmentBytes = this.attachments.recordReferences(
        sessionId,
        message,
        extracted,
        now
      );
    });

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
        cache.rawBytes += byteLength(json);
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
  ): Promise<boolean> {
    const oldRows = this.io.sql<{
      token_estimate: number;
      content: string;
    }>(
      "SELECT token_estimate, content FROM cf_agents_session_messages WHERE id = ? AND session_id = ?",
      [message.id, sessionId]
    );
    if (oldRows.length === 0) {
      if (this.#missingUpdate === "ignore") return Promise.resolve(false);
      throw new SessionMessageNotFoundError(sessionId, message.id);
    }
    const old = oldRows[0];
    const json = this.#serialize(message);
    const tokenEstimate = this.estimateRowTokens(message, extracted);
    const mediaCandidateBytes = this.#mediaCandidateBytesAtWrite(message);
    const hadPointers = old.content.includes(ATTACHMENT_URL_PREFIX);
    const hasPointers =
      extracted.length > 0 || json.includes(ATTACHMENT_URL_PREFIX);
    let previousHashes: string[] = [];
    this.io.transaction(() => {
      this.io.sqlWrite(
        `UPDATE cf_agents_session_messages
         SET role = ?, content = ?, token_estimate = ?, media_candidate_bytes = ?
         WHERE id = ? AND session_id = ?`,
        [
          message.role,
          json,
          tokenEstimate,
          mediaCandidateBytes,
          message.id,
          sessionId
        ]
      );
      if (this.#searchIndexing) this.#indexFts(sessionId, message, true);
      if (hadPointers || hasPointers) {
        previousHashes = this.attachments.replaceReferenceRows(
          sessionId,
          message,
          extracted,
          Date.now()
        );
      }
    });

    if (hadPointers || hasPointers) {
      this.#statsCache.delete(sessionId);
    } else {
      const cache = this.#statsCache.get(sessionId);
      if (cache?.pathIdSet.has(message.id)) {
        cache.rawTokens += tokenEstimate - old.token_estimate;
        cache.rawBytes += byteLength(json) - byteLength(old.content);
      }
    }
    this.io.emit("session:message:updated", {
      sessionId,
      messageId: message.id
    });
    return this.attachments.reapUnreferenced(previousHashes).then(() => true);
  }

  /**
   * Select unexamined aged rows for a bounded media pass. Content enters JS
   * only for these rows; the active path and age cutoff were derived from
   * content-free stats first.
   */
  mediaMaintenanceCandidates(
    sessionId: string,
    messageIds: readonly string[],
    minBytes: number,
    limit: number
  ): Array<{ content: string; message: SessionMessage }> {
    if (messageIds.length === 0) return [];
    const rows = this.io.sql<{ id: string; content: string }>(
      `SELECT id, content FROM cf_agents_session_messages
       WHERE session_id = ?
         AND media_candidate_bytes >= ?
         AND id IN (SELECT value FROM json_each(?))
       ORDER BY rowid ASC
       LIMIT ?`,
      [sessionId, minBytes, JSON.stringify(messageIds), limit]
    );
    const candidates: Array<{ content: string; message: SessionMessage }> = [];
    for (const row of rows) {
      const message = this.#parse(row.content);
      if (message) {
        candidates.push({ content: row.content, message });
      } else {
        this.markMediaCandidate(sessionId, row.id, row.content, 0);
      }
    }
    return candidates;
  }

  /** Content-free probe used after a bounded maintenance pass. */
  hasMediaMaintenanceCandidate(
    sessionId: string,
    messageIds: readonly string[],
    minBytes: number
  ): boolean {
    if (messageIds.length === 0) return false;
    return (
      this.io.sql<{ present: number }>(
        `SELECT 1 AS present FROM cf_agents_session_messages
         WHERE session_id = ?
           AND media_candidate_bytes >= ?
           AND id IN (SELECT value FROM json_each(?))
         LIMIT 1`,
        [sessionId, minBytes, JSON.stringify(messageIds)]
      ).length > 0
    );
  }

  /** Correct a conservative legacy candidate hint after examining one row. */
  markMediaCandidate(
    sessionId: string,
    messageId: string,
    expectedContent: string,
    candidateBytes: number
  ): void {
    this.io.sqlWrite(
      `UPDATE cf_agents_session_messages SET media_candidate_bytes = ?
       WHERE id = ? AND session_id = ? AND content = ?`,
      [candidateBytes, messageId, sessionId, expectedContent]
    );
  }

  /**
   * Compare-and-swap rewrite used by bounded maintenance passes. Blob writes
   * happen before this call; a changed source row rejects the rewrite and
   * discards any now-unreferenced blobs instead of overwriting a live turn.
   */
  async rewriteForMaintenance(
    sessionId: string,
    expectedContent: string,
    message: SessionMessage,
    attachments: readonly StoredAttachment[]
  ): Promise<boolean> {
    const json = this.#serialize(message);
    const tokenEstimate = this.estimateRowTokens(message, []);
    const mediaCandidateBytes = this.#mediaCandidateBytesAtWrite(message);
    let updated = 0;
    let previousHashes: string[] = [];
    this.io.transaction(() => {
      updated = this.io.sqlWrite(
        `UPDATE cf_agents_session_messages
         SET role = ?, content = ?, token_estimate = ?, media_candidate_bytes = ?
         WHERE id = ? AND session_id = ? AND content = ?`,
        [
          message.role,
          json,
          tokenEstimate,
          mediaCandidateBytes,
          message.id,
          sessionId,
          expectedContent
        ]
      );
      if (updated === 0) return;
      if (this.#searchIndexing) this.#indexFts(sessionId, message, true);
      previousHashes = this.attachments.replaceReferenceRows(
        sessionId,
        message,
        attachments,
        Date.now()
      );
    });
    if (updated === 0) {
      await this.attachments.discardUnreferenced(attachments);
      return false;
    }

    await this.attachments.reapUnreferenced(previousHashes);
    this.#statsCache.delete(sessionId);
    this.io.emit("session:message:maintenance-rewritten", {
      sessionId,
      messageId: message.id
    });
    return true;
  }

  /**
   * Delete rows, SPLICING children to their grandparent so a mid-chain
   * delete never decapitates older history (the legacy provider left a gap
   * that silently truncated the recursive path walk).
   */
  async deleteMessages(sessionId: string, messageIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(messageIds)];
    if (uniqueIds.length === 0) return;
    const ids = JSON.stringify(uniqueIds);

    // Rewire only surviving boundary children. A recursive walk skips any
    // run of deleted ancestors and lands on the nearest surviving parent.
    // Prefix retention therefore writes one boundary child, not one child per
    // deleted message.
    let affectedHashes: string[] = [];
    this.io.transaction(() => {
      this.io.sqlWrite(
        `WITH RECURSIVE
         deleted(id) AS (SELECT value FROM json_each(?)),
         rewire(child_id, ancestor_id, depth) AS (
           SELECT child.id, child.parent_id, 0
           FROM cf_agents_session_messages AS child
           JOIN deleted ON deleted.id = child.parent_id
           WHERE child.session_id = ?
             AND child.id NOT IN (SELECT id FROM deleted)
           UNION ALL
           SELECT rewire.child_id, parent.parent_id, rewire.depth + 1
           FROM rewire
           JOIN cf_agents_session_messages AS parent
             ON parent.id = rewire.ancestor_id
           JOIN deleted ON deleted.id = parent.id
           WHERE parent.session_id = ? AND rewire.depth < 10000
         ),
         nearest(child_id, ancestor_id) AS (
           SELECT child_id, ancestor_id FROM rewire
           WHERE ancestor_id IS NULL
              OR ancestor_id NOT IN (SELECT id FROM deleted)
         )
       UPDATE cf_agents_session_messages
       SET parent_id = (
         SELECT nearest.ancestor_id FROM nearest
         WHERE nearest.child_id = cf_agents_session_messages.id
       )
         WHERE session_id = ?
           AND id IN (SELECT child_id FROM nearest)`,
        [ids, sessionId, sessionId, sessionId]
      );
      this.io.sqlWrite(
        `DELETE FROM cf_agents_session_messages
         WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
        [sessionId, ids]
      );
      if (this.#searchIndexing) {
        this.io.sqlWrite(
          `DELETE FROM cf_agents_session_fts
           WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
          [sessionId, ids]
        );
      }
      affectedHashes = this.attachments.deleteMessageReferenceRows(
        sessionId,
        uniqueIds
      );
    });
    await this.attachments.reapUnreferenced(affectedHashes);
    const cachedLeaf = this.#leafCache.get(sessionId);
    if (typeof cachedLeaf === "string" && uniqueIds.includes(cachedLeaf)) {
      this.#leafCache.delete(sessionId);
    }
    this.#statsCache.delete(sessionId);
    this.io.emit("session:messages:deleted", {
      sessionId,
      count: uniqueIds.length
    });
  }

  async clearMessages(sessionId: string): Promise<void> {
    let affectedHashes: string[] = [];
    this.io.transaction(() => {
      this.io.sqlWrite(
        "DELETE FROM cf_agents_session_messages WHERE session_id = ?",
        [sessionId]
      );
      this.io.sqlWrite(
        "DELETE FROM cf_agents_session_compactions WHERE session_id = ?",
        [sessionId]
      );
      if (this.#searchIndexing) {
        this.io.sqlWrite(
          "DELETE FROM cf_agents_session_fts WHERE session_id = ?",
          [sessionId]
        );
      }
      affectedHashes = this.attachments.deleteSessionReferenceRows(sessionId);
    });
    await this.attachments.reapUnreferenced(affectedHashes);
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

  #indexFts(
    sessionId: string,
    message: SessionMessage,
    replace: boolean
  ): void {
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join(" ");
    // Updates delete first to handle text-to-no-text transitions. Appends and
    // imports know their ID is new and skip the read/delete entirely.
    if (replace) this.#deleteFts(sessionId, message.id);
    if (text) {
      this.io.sqlWrite(
        "INSERT INTO cf_agents_session_fts (id, session_id, role, content) VALUES (?, ?, ?, ?)",
        [message.id, sessionId, message.role, text]
      );
    }
  }

  #deleteFts(sessionId: string, id: string): void {
    this.io.sqlWrite(
      "DELETE FROM cf_agents_session_fts WHERE id = ? AND session_id = ?",
      [id, sessionId]
    );
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
            (id, session_id, parent_id, role, content, token_estimate, media_candidate_bytes, created_at)
           SELECT ?, ?, ?, role, ?, token_estimate, media_candidate_bytes, created_at
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
        if (this.#searchIndexing) {
          this.#indexFts(toSessionId, copied, false);
        }
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
        (id, session_id, parent_id, role, content, token_estimate, media_candidate_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        sessionId,
        options.parentId,
        message.role,
        json,
        this.estimateRowTokens(message, []),
        this.#mediaCandidateBytesAtWrite(message),
        options.createdAt
      ]
    );
    if (inserted === 0) return;
    if (this.#searchIndexing) this.#indexFts(sessionId, message, false);
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

  // ── Context and lifted config ────────────────────────────────────────────

  getContextValue(label: string): string | null {
    const rows = this.io.sql<{ content: string }>(
      "SELECT content FROM cf_agents_context_blocks WHERE label = ?",
      [label]
    );
    return rows[0]?.content ?? null;
  }

  setContextValue(label: string, content: string): void {
    this.io.sqlWrite(
      `INSERT INTO cf_agents_context_blocks (label, content)
       VALUES (?, ?)
       ON CONFLICT(label) DO UPDATE SET
         content = excluded.content,
         updated_at = CURRENT_TIMESTAMP`,
      [label, content]
    );
  }

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
