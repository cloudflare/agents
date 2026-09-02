/**
 * @internal Storage engine behind the Sessions capability. One instance per
 * capability, owning the `cf_agents_session_*` tables. All methods assume the
 * caller has settled startup ordering (`lifecycle.ready()` for public API,
 * explicit ownership for the sync aperture).
 *
 * Write economics: rows written cost ~1000× rows read on DO SQLite. Every
 * table is WITHOUT ROWID with no secondary index, so one row write bills one
 * row. State is derived from existing rows (active leaf = the session's
 * max-seq row; token totals from stamped per-row estimates), never kept in
 * counter rows, and an unchanged update writes nothing.
 */

import {
  extractAttachments,
  referencedAttachments,
  resolveAttachments
} from "./attachment-ingest";
import { AttachmentStore } from "./attachment-store";
import { splitContent } from "./chunking";
import {
  SessionSearchDisabledError,
  SessionSerializationError
} from "./errors";
import type { SessionsIo } from "./io";
import { overlayMessage, planOverlays } from "./overlays";
import { byteLength } from "./sanitize";
import {
  estimateAttachmentTokens,
  estimatedDataUrlBytes,
  estimateMessageTokens,
  estimateStringTokens
} from "./tokens";
import type {
  AttachmentMode,
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
 * Bounds for each content-hydration query on a history path. In workerd the
 * SQLite allocator shares the isolate's memory budget with the JS heap, so
 * oversized transient result sets surface as SQLITE_NOMEM (#1710). Chunks
 * are bounded by BOTH row count and cumulative stored bytes.
 */
const HISTORY_CONTENT_CHUNK_SIZE = 50;
const HISTORY_CONTENT_CHUNK_BYTES = 4 * 1024 * 1024;

/** Per-session O(1)-maintained aggregates over the active branch path. */
type StatsCache = {
  leafId: string | null;
  pathIds: string[];
  pathIdSet: Set<string>;
  rawTokens: number;
  rawBytes: number;
  /** −(covered span tokens) + (summary tokens) for applicable overlays. */
  overlayAdjustment: number;
};

export type UpdateOutcome = "missing" | "unchanged" | "updated";

export class SessionsCore {
  readonly io: SessionsIo;
  readonly #searchIndexing: boolean;
  readonly #reservedMetadataKeys: readonly string[];
  #tablesEnsured = false;

  readonly #listeners = new Set<SessionChangeListener>();
  /** Active-leaf cache per session: undefined = cold, null = empty session. */
  readonly #leafCache = new Map<string, string | null>();
  /** Next `seq` per session; the capability is the only writer. */
  readonly #nextSeq = new Map<string, number>();
  readonly #statsCache = new Map<string, StatsCache>();
  readonly #attachments: AttachmentStore;

  constructor(options: SessionsOptions, io: SessionsIo) {
    this.io = io;
    this.#attachments = new AttachmentStore(io);
    this.#searchIndexing = options.searchIndexing ?? false;
    this.#reservedMetadataKeys = options.reservedMetadataKeys ?? [];
  }

  // ── Schema ───────────────────────────────────────────────────────────────

  ensureTables(): void {
    if (this.#tablesEnsured) return;
    this.io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS cf_agents_session_messages (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        parent_id TEXT,
        type TEXT NOT NULL DEFAULT 'message',
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        content_chunks INTEGER NOT NULL DEFAULT 0,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, id)
      ) WITHOUT ROWID`,
      []
    );
    this.io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS cf_agents_session_message_chunks (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (session_id, id, idx)
      ) WITHOUT ROWID`,
      []
    );
    this.io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS cf_agents_session_compactions (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        summary TEXT NOT NULL,
        from_message_id TEXT NOT NULL,
        to_message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, id)
      ) WITHOUT ROWID`,
      []
    );
    this.io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS cf_agents_session_config (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      ) WITHOUT ROWID`,
      []
    );
    this.#attachments.ensureTables();
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
    this.io.sqlWrite(
      `CREATE VIRTUAL TABLE cf_agents_session_fts
       USING fts5(id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content, tokenize='porter unicode61')`,
      []
    );
    this.#backfillMissingFtsRows();
  }

  /** Index rows that predate indexing, in SQL, without loading JSON into JS. */
  #backfillMissingFtsRows(): void {
    this.io.sqlWrite(
      `INSERT INTO cf_agents_session_fts (id, session_id, role, content)
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
       GROUP BY m.id, m.session_id, m.role`,
      []
    );
  }

  /**
   * One-time lift of the legacy `assistant_*` message and compaction tables.
   *
   * The copy is pure SQL, so SQLite streams it rather than materializing rows
   * in the isolate. Each source table is then verified row by row against its
   * destination and DROPPED. Keeping the originals as renamed tombstones would
   * leave every upgraded object holding its conversation history twice, which
   * on a large store is both a bill and a headroom problem: a Durable Object
   * tops out at 10 GB and gets uncomfortable well before that, so a 5 GB
   * history plus its copy has nowhere to go. The copy already needs that
   * space transiently, which is exactly why it must not be kept. A table whose verification fails is
   * left in place with a `session:migration:incomplete` event so the rows can
   * still be recovered by hand. `assistant_config` belongs to Think, which
   * lifts and drops it itself.
   */
  /**
   * Lift legacy `assistant_*` tables. Returns false when any source could not
   * be fully copied, so the caller can leave the schema version unstamped and
   * retry on a later start rather than stranding the rows.
   */
  migrateLegacy(): boolean {
    let complete = true;
    const legacy = (name: string): boolean =>
      this.io.sql<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        [name]
      ).length > 0;
    const drop = (name: string): void => {
      if (legacy(name)) this.io.sqlWrite(`DROP TABLE ${name}`, []);
    };
    /**
     * Drop a lifted source only once every one of its rows has a copy holding
     * the same payload. Matching on the key alone would accept a destination
     * row that merely occupies the key, and dropping a table that was not
     * fully copied is the one failure this migration must never have.
     */
    const dropWhenCopied = (
      source: string,
      destination: string,
      payload: string
    ): void => {
      const [counts] = this.io.sql<{ source: number; copied: number }>(
        `SELECT
           (SELECT COUNT(*) FROM ${source}) AS source,
           (SELECT COUNT(*) FROM ${source} AS legacy
             JOIN ${destination} AS lifted
               ON lifted.session_id = legacy.session_id
              AND lifted.id = legacy.id
              AND lifted.${payload} = legacy.${payload}) AS copied`,
        []
      );
      if (counts && counts.source === counts.copied) {
        drop(source);
        return;
      }
      complete = false;
      this.io.emit("session:migration:incomplete", {
        table: source,
        source: counts?.source ?? 0,
        copied: counts?.copied ?? 0
      });
    };

    if (legacy("assistant_messages")) {
      this.io.sqlWrite(
        `INSERT OR IGNORE INTO cf_agents_session_messages
          (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
         SELECT session_id, id,
           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at ASC, rowid ASC),
           parent_id, role, content,
           CAST(LENGTH(CAST(content AS BLOB)) / 4 AS INTEGER),
           COALESCE(CAST(strftime('%s', created_at) AS INTEGER), 0) * 1000
         FROM assistant_messages`,
        []
      );
      // The FTS index is rebuilt from the lifted rows below, so the old one is
      // redundant the moment its messages land.
      if (this.#searchIndexing) this.#backfillMissingFtsRows();
      dropWhenCopied(
        "assistant_messages",
        "cf_agents_session_messages",
        "content"
      );
    }
    if (legacy("assistant_compactions")) {
      this.io.sqlWrite(
        `INSERT OR IGNORE INTO cf_agents_session_compactions
          (session_id, id, seq, summary, from_message_id, to_message_id, created_at)
         SELECT session_id, id,
           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at ASC, rowid ASC),
           summary, from_message_id, to_message_id,
           COALESCE(CAST(strftime('%s', created_at) AS INTEGER), 0) * 1000
         FROM assistant_compactions`,
        []
      );
      dropWhenCopied(
        "assistant_compactions",
        "cf_agents_session_compactions",
        "summary"
      );
    }
    // Neither carries data the new schema needs: the registry is derived from
    // message rows now, and the index is rebuilt from message text.
    drop("assistant_sessions");
    drop("assistant_fts");
    return complete;
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

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * Continuation slices for the given ids, keyed by id and already joined in
   * `idx` order. One query, and only for ids the caller knows have them.
   */
  #continuations(
    sessionId: string,
    ids: readonly string[]
  ): Map<string, string> {
    const joined = new Map<string, string>();
    if (ids.length === 0) return joined;
    const rows = this.io.sql<{ id: string; content: string }>(
      `SELECT id, content FROM cf_agents_session_message_chunks
       WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))
       ORDER BY id ASC, idx ASC`,
      [sessionId, JSON.stringify([...ids])]
    );
    for (const row of rows) {
      joined.set(row.id, (joined.get(row.id) ?? "") + row.content);
    }
    return joined;
  }

  /** Reassemble one stored row, reading continuations only when it has any. */
  #content(sessionId: string, id: string): string | null {
    const rows = this.io.sql<{ content: string; content_chunks: number }>(
      "SELECT content, content_chunks FROM cf_agents_session_messages WHERE session_id = ? AND id = ?",
      [sessionId, id]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.content_chunks === 0) return row.content;
    return row.content + (this.#continuations(sessionId, [id]).get(id) ?? "");
  }

  /** One message with payloads inlined — the host-facing single read. */
  getMessage(sessionId: string, id: string): SessionMessage | null {
    const raw = this.getMessageRaw(sessionId, id);
    return raw && this.#inline(raw);
  }

  /** One message in stored form, pointers left as they are. */
  getMessageRaw(sessionId: string, id: string): SessionMessage | null {
    const content = this.#content(sessionId, id);
    return content === null ? null : this.#parse(content);
  }

  latestLeafId(sessionId: string): string | null {
    const cached = this.#leafCache.get(sessionId);
    if (cached !== undefined) return cached;
    // Children insert after their parents, so the session's max-seq row is
    // provably childless. Every write path maintains this cache in place.
    const rows = this.io.sql<{ id: string }>(
      "SELECT id FROM cf_agents_session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
      [sessionId]
    );
    const leafId = rows[0]?.id ?? null;
    this.#leafCache.set(sessionId, leafId);
    return leafId;
  }

  #resolveLeafId(sessionId: string, leafId?: string | null): string | null {
    if (leafId) {
      const rows = this.io.sql<{ id: string }>(
        "SELECT id FROM cf_agents_session_messages WHERE session_id = ? AND id = ?",
        [sessionId, leafId]
      );
      return rows[0]?.id ?? null;
    }
    return this.latestLeafId(sessionId);
  }

  getLatestLeaf(sessionId: string): SessionMessage | null {
    const leafId = this.latestLeafId(sessionId);
    return leafId ? this.getMessage(sessionId, leafId) : null;
  }

  getBranches(sessionId: string, messageId: string): SessionMessage[] {
    const rows = this.io.sql<{
      id: string;
      content: string;
      content_chunks: number;
    }>(
      `SELECT id, content, content_chunks FROM cf_agents_session_messages
       WHERE session_id = ? AND parent_id = ? ORDER BY seq ASC`,
      [sessionId, messageId]
    );
    const continued = this.#continuations(
      sessionId,
      rows.filter((row) => row.content_chunks > 0).map((row) => row.id)
    );
    const result: SessionMessage[] = [];
    for (const row of rows) {
      const parsed = this.#parse(
        row.content_chunks === 0
          ? row.content
          : row.content + (continued.get(row.id) ?? "")
      );
      if (parsed) result.push(this.#inline(parsed));
    }
    return result;
  }

  /**
   * The active branch path as content-free rows, root → leaf. Recurses over
   * (id, parent_id) only — carrying content through the recursive queue
   * materializes the transcript several times inside SQLite (#1710).
   * `bytes` counts the message row, its continuation rows, AND the payloads
   * it points at, charged at the size they take once inlined. Extraction makes
   * the row of a message carrying a 2 MB image tiny, so counting rows alone
   * would let a byte budget admit a window that hydrates far larger than it
   * measured. Charging the payload keeps the budget a bound on real memory.
   */
  pathRowStats(sessionId: string, leafId?: string | null): SessionRowStat[] {
    const leaf = this.#resolveLeafId(sessionId, leafId);
    if (!leaf) return [];
    return this.io.sql<SessionRowStat>(
      `WITH RECURSIVE path(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM cf_agents_session_messages
        WHERE session_id = ? AND id = ?
        UNION ALL
        SELECT m.id, m.parent_id, p.depth + 1 FROM cf_agents_session_messages m
        JOIN path p ON m.id = p.parent_id
        WHERE m.session_id = ? AND p.depth < 10000
      )
      SELECT path.id AS id, am.role AS role,
        LENGTH(CAST(am.content AS BLOB)) + CASE WHEN am.content_chunks = 0 THEN 0
          ELSE COALESCE((
            SELECT SUM(LENGTH(CAST(c.content AS BLOB)))
            FROM cf_agents_session_message_chunks c
            WHERE c.session_id = am.session_id AND c.id = am.id
          ), 0) END
        + COALESCE((
            SELECT SUM((meta.bytes + 2) / 3 * 4)
            FROM cf_agents_session_attachment_refs r
            JOIN cf_agents_session_attachment_meta meta ON meta.hash = r.hash
            WHERE r.session_id = am.session_id AND r.message_id = am.id
          ), 0) AS bytes,
        am.token_estimate AS tokenEstimate
      FROM path JOIN cf_agents_session_messages am
        ON am.session_id = ? AND am.id = path.id
      ORDER BY path.depth DESC`,
      [sessionId, leaf, sessionId, sessionId]
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

  /**
   * Fetch and parse one already-bounded content window. The common window
   * has no continuation rows at all, so the second query is issued only for
   * the ids that actually carry them and never runs otherwise.
   */
  #contentByStats(
    sessionId: string,
    rows: readonly SessionRowStat[],
    attachments: AttachmentMode = "inline"
  ): Map<string, SessionMessage> {
    const result = new Map<string, SessionMessage>();
    if (rows.length === 0) return result;
    const fetched = this.io.sql<{
      id: string;
      content: string;
      content_chunks: number;
    }>(
      `SELECT id, content, content_chunks FROM cf_agents_session_messages
       WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
      [sessionId, JSON.stringify(rows.map((row) => row.id))]
    );
    const continued = this.#continuations(
      sessionId,
      fetched.filter((row) => row.content_chunks > 0).map((row) => row.id)
    );
    for (const row of fetched) {
      const parsed = this.#parse(
        row.content_chunks === 0
          ? row.content
          : row.content + (continued.get(row.id) ?? "")
      );
      if (parsed) {
        result.set(
          row.id,
          attachments === "inline" ? this.#inline(parsed) : parsed
        );
      }
    }
    return result;
  }

  /** Iterate selected raw path rows in bounded content queries. */
  *rawMessagesByStats(
    sessionId: string,
    stats: readonly SessionRowStat[],
    reverse = false
  ): Generator<SessionMessage, void, undefined> {
    const ordered = reverse ? [...stats].reverse() : stats;
    for (const chunk of this.#boundedStatsChunks(ordered)) {
      const content = this.#contentByStats(sessionId, chunk, "pointer");
      for (const row of chunk) {
        const parsed = content.get(row.id);
        if (parsed) yield parsed;
      }
    }
  }

  /** Stream a known path window without retaining earlier content chunks. */
  async *#streamStats(
    sessionId: string,
    stats: readonly SessionRowStat[],
    compactions: readonly StoredCompaction[],
    signal?: AbortSignal,
    attachments: AttachmentMode = "inline"
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
        const content = this.#contentByStats(sessionId, chunk, attachments);
        for (const row of chunk) {
          const parsed = content.get(row.id);
          if (parsed) yield parsed;
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
   * compaction overlays collapsed. Peak memory is one bounded content window
   * — never the whole transcript.
   */
  async *streamHistory(
    sessionId: string,
    options: HistoryReadOptions
  ): AsyncGenerator<SessionMessage, void, undefined> {
    const stats = this.pathRowStats(sessionId, options.leafId);
    if (stats.length === 0) return;
    yield* this.#streamStats(
      sessionId,
      stats,
      this.getCompactions(sessionId),
      options.signal,
      options.attachments
    );
  }

  async getHistory(
    sessionId: string,
    options: HistoryReadOptions
  ): Promise<SessionMessage[]> {
    const messages: SessionMessage[] = [];
    for await (const message of this.streamHistory(sessionId, options)) {
      messages.push(message);
    }
    return messages;
  }

  /**
   * Byte-budgeted read of the most recent messages on the active branch
   * path — the longest suffix whose stored size fits `maxContentBytes`.
   * Stored size counts each row, its continuation rows, and the payloads it
   * points at, so the budget bounds real hydrated memory.
   *
   * There is no message-count floor. One used to exist, and it silently
   * defeated the budget: it admitted rows regardless of size, so a window of
   * media-heavy messages could hydrate far past the limit that was supposed to
   * bound it. The newest message is always returned even if it alone exceeds
   * the budget, since returning nothing is worse; that single row is the one
   * case the budget cannot bound.
   * Overlays whose anchors fall outside the window are skipped, showing the
   * raw recent messages (the intended degraded view).
   */
  async getRecentHistory(
    sessionId: string,
    maxContentBytes: number,
    leafId?: string | null
  ): Promise<RecentHistoryResult> {
    const stats = this.pathRowStats(sessionId, leafId);
    if (stats.length === 0) {
      return { messages: [], truncated: false, totalContentBytes: 0 };
    }
    const totalContentBytes = stats.reduce((sum, row) => sum + row.bytes, 0);
    let start = stats.length - 1;
    let used = stats[start].bytes;
    while (start > 0) {
      const next = stats[start - 1].bytes;
      if (used + next > maxContentBytes) break;
      start--;
      used += next;
    }

    const messages: SessionMessage[] = [];
    for await (const message of this.#streamStats(
      sessionId,
      stats.slice(start),
      this.getCompactions(sessionId)
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
      pathLength: cache.pathIds.length
    };
  }

  #deriveStats(sessionId: string): StatsCache {
    const cached = this.#statsCache.get(sessionId);
    if (cached) return cached;
    const stats = this.pathRowStats(sessionId);
    const pathIds = stats.map((row) => row.id);
    const spans = planOverlays(pathIds, this.getCompactions(sessionId));
    let overlayAdjustment = 0;
    for (const span of spans) {
      for (let i = span.startIndex; i <= span.endIndex; i++) {
        overlayAdjustment -= stats[i].tokenEstimate;
      }
      overlayAdjustment += estimateStringTokens(span.compaction.summary);
    }
    const cache: StatsCache = {
      leafId: pathIds.at(-1) ?? null,
      pathIds,
      pathIdSet: new Set(pathIds),
      rawTokens: stats.reduce((sum, row) => sum + row.tokenEstimate, 0),
      rawBytes: stats.reduce((sum, row) => sum + row.bytes, 0),
      overlayAdjustment
    };
    this.#statsCache.set(sessionId, cache);
    return cache;
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
    const metadata: Record<string, unknown> = { ...message.metadata };
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

  /**
   * Stamped row estimate: the part heuristic over the message as written,
   * plus a weight per inline file payload so media never counts as zero.
   */
  estimateRowTokens(message: SessionMessage): number {
    let tokens = estimateMessageTokens([message]);
    for (const part of message.parts) {
      if (part.type !== "file") continue;
      if (typeof part.url === "string" && part.url.startsWith("data:")) {
        tokens += estimateAttachmentTokens(
          part.mediaType ?? "application/octet-stream",
          estimatedDataUrlBytes(part.url)
        );
      }
    }
    return tokens;
  }

  #allocateSeq(sessionId: string): number {
    const cached = this.#nextSeq.get(sessionId);
    const seq =
      cached ??
      this.io.sql<{ seq: number }>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM cf_agents_session_messages WHERE session_id = ?",
        [sessionId]
      )[0]?.seq ??
      1;
    this.#nextSeq.set(sessionId, seq + 1);
    return seq;
  }

  /**
   * Write one message's slices: the row itself plus its continuation rows.
   * Callers run this inside their own transaction, so a message and its
   * continuations always commit together.
   */
  #writeContinuations(
    sessionId: string,
    id: string,
    slices: readonly string[]
  ): void {
    for (let idx = 1; idx < slices.length; idx++) {
      this.io.sqlWrite(
        `INSERT OR REPLACE INTO cf_agents_session_message_chunks
          (session_id, id, idx, content) VALUES (?, ?, ?, ?)`,
        [sessionId, id, idx, slices[idx]]
      );
    }
  }

  /**
   * Durable append. The caller has already sanitized the message. Message,
   * continuation, and FTS rows commit in one synchronous SQLite transaction.
   */
  append(
    sessionId: string,
    message: SessionMessage,
    parentId: string | null | undefined,
    tokenEstimate: number
  ): { inserted: boolean; parentId: string | null } {
    const existing = this.io.sql<{ id: string }>(
      "SELECT id FROM cf_agents_session_messages WHERE session_id = ? AND id = ?",
      [sessionId, message.id]
    );
    if (existing.length > 0) return { inserted: false, parentId: null };

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
          "SELECT id FROM cf_agents_session_messages WHERE session_id = ? AND id = ?",
          [sessionId, parent]
        );
        if (valid.length === 0) parent = null;
      }
    }

    // Inline media leaves the message before it is serialized, so the row
    // holds a pointer and never the payload. Addresses are computed here, out
    // of the transaction; the transaction only writes.
    const { message: staged, attachments } = extractAttachments(message);
    const json = this.#serialize(staged);
    const slices = splitContent(json);
    const seq = this.#allocateSeq(sessionId);
    const now = Date.now();
    this.io.transaction(() => {
      for (const attachment of attachments) {
        this.#attachments.put(attachment.payload, attachment.hash);
      }
      this.io.sqlWrite(
        `INSERT INTO cf_agents_session_messages
          (session_id, id, seq, parent_id, role, content, content_chunks, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          message.id,
          seq,
          parent,
          message.role,
          slices[0],
          slices.length - 1,
          tokenEstimate,
          now
        ]
      );
      this.#writeContinuations(sessionId, message.id, slices);
      // Every pointer the STORED message carries, not just the ones this write
      // extracted: a message read in pointer mode and written back still holds
      // references that extraction never saw, and they must stay alive.
      this.#attachments.addRefs(
        sessionId,
        message.id,
        referencedAttachments(staged)
      );
      if (this.#searchIndexing) this.#indexFts(sessionId, staged, false);
    });

    // The freshly inserted row is the most recent childless node, so it is
    // now the latest leaf — true even for an explicit-parent branch append.
    const previousLeaf = this.#leafCache.get(sessionId);
    this.#leafCache.set(sessionId, message.id);

    const cache = this.#statsCache.get(sessionId);
    if (cache) {
      if (parent === cache.leafId && previousLeaf === cache.leafId) {
        cache.leafId = message.id;
        cache.pathIds.push(message.id);
        cache.pathIdSet.add(message.id);
        cache.rawTokens += tokenEstimate;
        cache.rawBytes += byteLength(json);
      } else {
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
   * Durable update of an existing row. An identical row writes nothing: no
   * row, no continuation, no FTS, no event. The no-op guard compares the
   * FULL reassembled content, not just the slice the message row holds.
   */
  async update(
    sessionId: string,
    message: SessionMessage,
    tokenEstimate: number
  ): Promise<UpdateOutcome> {
    const oldRows = this.io.sql<{
      token_estimate: number;
      content: string;
      content_chunks: number;
    }>(
      "SELECT token_estimate, content, content_chunks FROM cf_agents_session_messages WHERE session_id = ? AND id = ?",
      [sessionId, message.id]
    );
    if (oldRows.length === 0) return "missing";
    const old = oldRows[0];
    const oldContent =
      old.content_chunks === 0
        ? old.content
        : old.content +
          (this.#continuations(sessionId, [message.id]).get(message.id) ?? "");
    // Compare in stored form: a re-sent identical image extracts to the same
    // address, so an unchanged update still writes nothing.
    const { message: staged, attachments } = extractAttachments(message);
    const json = this.#serialize(staged);
    if (oldContent === json) return "unchanged";

    const slices = splitContent(json);
    this.io.transaction(() => {
      for (const attachment of attachments) {
        this.#attachments.put(attachment.payload, attachment.hash);
      }
      this.io.sqlWrite(
        `UPDATE cf_agents_session_messages
         SET role = ?, content = ?, content_chunks = ?, token_estimate = ?
         WHERE session_id = ? AND id = ?`,
        [
          message.role,
          slices[0],
          slices.length - 1,
          tokenEstimate,
          sessionId,
          message.id
        ]
      );
      // A message that shrank leaves surplus continuations behind; they go
      // in the same transaction as the row that stopped referencing them.
      if (old.content_chunks > slices.length - 1) {
        this.io.sqlWrite(
          `DELETE FROM cf_agents_session_message_chunks
           WHERE session_id = ? AND id = ? AND idx > ?`,
          [sessionId, message.id, slices.length - 1]
        );
      }
      this.#writeContinuations(sessionId, message.id, slices);
      // Payloads are stored before references move, so a hash this message
      // still uses is never momentarily unreferenced and collected.
      this.#attachments.replaceRefs(
        sessionId,
        message.id,
        referencedAttachments(staged)
      );
      if (this.#searchIndexing) this.#indexFts(sessionId, staged, true);
    });

    const cache = this.#statsCache.get(sessionId);
    if (cache?.pathIdSet.has(message.id)) {
      cache.rawTokens += tokenEstimate - old.token_estimate;
      cache.rawBytes += byteLength(json) - byteLength(oldContent);
    }
    this.io.emit("session:message:updated", {
      sessionId,
      messageId: message.id
    });
    return "updated";
  }

  /**
   * Delete rows, SPLICING children to their grandparent so a mid-chain
   * delete never decapitates older history. Only surviving boundary children
   * are rewired: a prefix delete writes one boundary child, not one child
   * per deleted message.
   */
  async deleteMessages(sessionId: string, messageIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(messageIds)];
    if (uniqueIds.length === 0) return;
    const ids = JSON.stringify(uniqueIds);

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
      this.io.sqlWrite(
        `DELETE FROM cf_agents_session_message_chunks
         WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
        [sessionId, ids]
      );
      this.#attachments.releaseMessages(sessionId, uniqueIds);
      if (this.#searchIndexing) {
        this.io.sqlWrite(
          `DELETE FROM cf_agents_session_fts
           WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
          [sessionId, ids]
        );
      }
    });
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
    this.io.transaction(() => {
      this.io.sqlWrite(
        "DELETE FROM cf_agents_session_messages WHERE session_id = ?",
        [sessionId]
      );
      this.io.sqlWrite(
        "DELETE FROM cf_agents_session_message_chunks WHERE session_id = ?",
        [sessionId]
      );
      this.io.sqlWrite(
        "DELETE FROM cf_agents_session_compactions WHERE session_id = ?",
        [sessionId]
      );
      this.#attachments.releaseSession(sessionId);
      if (this.#searchIndexing) {
        this.io.sqlWrite(
          "DELETE FROM cf_agents_session_fts WHERE session_id = ?",
          [sessionId]
        );
      }
    });
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
    const seq =
      this.io.sql<{ seq: number }>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM cf_agents_session_compactions WHERE session_id = ?",
        [sessionId]
      )[0]?.seq ?? 1;
    this.io.sqlWrite(
      `INSERT INTO cf_agents_session_compactions
        (session_id, id, seq, summary, from_message_id, to_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, id, seq, summary, fromMessageId, toMessageId, now]
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
        `SELECT id, summary, from_message_id, to_message_id, created_at
         FROM cf_agents_session_compactions
         WHERE session_id = ? ORDER BY seq ASC`,
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
    // Quote the query as a literal phrase, escaping embedded double quotes,
    // so user input cannot inject FTS5 syntax.
    const sanitized = `"${query.replace(/"/g, '""')}"`;
    try {
      return this.io
        .sql<{ id: string; role: string; content: string }>(
          `SELECT f.id, f.role, f.content FROM cf_agents_session_fts f
           INNER JOIN cf_agents_session_messages m
             ON m.session_id = f.session_id AND m.id = f.id
           WHERE cf_agents_session_fts MATCH ? AND f.session_id = ?
           ORDER BY rank LIMIT ?`,
          [sanitized, sessionId, limit]
        )
        .map((row) => ({ id: row.id, role: row.role, content: row.content }));
    } catch {
      return [];
    }
  }

  /** Maintain the FTS row; on replace, an unchanged text writes nothing. */
  #indexFts(
    sessionId: string,
    message: SessionMessage,
    replace: boolean
  ): void {
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join(" ");
    if (replace) {
      const existing = this.io.sql<{ content: string }>(
        "SELECT content FROM cf_agents_session_fts WHERE id = ? AND session_id = ?",
        [message.id, sessionId]
      );
      if (existing.length > 0) {
        if (existing[0].content === text) return;
        this.io.sqlWrite(
          "DELETE FROM cf_agents_session_fts WHERE id = ? AND session_id = ?",
          [message.id, sessionId]
        );
      }
    }
    if (text) {
      this.io.sqlWrite(
        "INSERT INTO cf_agents_session_fts (id, session_id, role, content) VALUES (?, ?, ?, ?)",
        [message.id, sessionId, message.role, text]
      );
    }
  }

  // ── Fork / import ────────────────────────────────────────────────────────

  /**
   * Copy the path ending at `atMessageId` (default: active leaf) into
   * another session in one transaction. Rows get fresh ids, so each copy is
   * re-split into its own row and continuation rows. Compaction overlays are
   * not copied (their anchors are re-ided).
   */
  fork(
    sessionId: string,
    toSessionId: string,
    atMessageId?: string
  ): { sessionId: string; leafId: string | null } {
    const stats = this.pathRowStats(sessionId, atMessageId ?? null);
    let previousNewId: string | null = null;
    this.io.transaction(() => {
      for (const window of this.#boundedStatsChunks(stats)) {
        // Pointer form: a fork copies references, it does not re-store bytes.
        const content = this.#contentByStats(sessionId, window, "pointer");
        for (const row of window) {
          const parsed = content.get(row.id);
          if (!parsed) continue;
          const newId = crypto.randomUUID();
          const copied = { ...parsed, id: newId };
          const slices = splitContent(this.#serialize(copied));
          this.io.sqlWrite(
            `INSERT INTO cf_agents_session_messages
              (session_id, id, seq, parent_id, role, content, content_chunks, token_estimate, created_at)
             SELECT ?, ?, ?, ?, role, ?, ?, token_estimate, created_at
             FROM cf_agents_session_messages WHERE session_id = ? AND id = ?`,
            [
              toSessionId,
              newId,
              this.#allocateSeq(toSessionId),
              previousNewId,
              slices[0],
              slices.length - 1,
              sessionId,
              row.id
            ]
          );
          this.#writeContinuations(toSessionId, newId, slices);
          this.#attachments.addRefs(
            toSessionId,
            newId,
            referencedAttachments(copied)
          );
          if (this.#searchIndexing) this.#indexFts(toSessionId, copied, false);
          previousNewId = newId;
        }
      }
    });
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
    const { message: staged, attachments } = extractAttachments(message);
    const slices = splitContent(this.#serialize(staged));
    let inserted = 0;
    this.io.transaction(() => {
      for (const attachment of attachments) {
        this.#attachments.put(attachment.payload, attachment.hash);
      }
      inserted = this.io.sqlWrite(
        `INSERT OR IGNORE INTO cf_agents_session_messages
          (session_id, id, seq, parent_id, role, content, content_chunks, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          message.id,
          this.#allocateSeq(sessionId),
          options.parentId,
          message.role,
          slices[0],
          slices.length - 1,
          this.estimateRowTokens(message),
          options.createdAt
        ]
      );
      if (inserted === 0) return;
      this.#writeContinuations(sessionId, message.id, slices);
      this.#attachments.addRefs(
        sessionId,
        message.id,
        referencedAttachments(staged)
      );
      if (this.#searchIndexing) this.#indexFts(sessionId, staged, false);
    });
    if (inserted === 0) return;
    this.#leafCache.set(sessionId, message.id);
    this.#statsCache.delete(sessionId);
  }

  // ── Parsing ──────────────────────────────────────────────────────────────

  /**
   * Put attachment payloads back inline. Reads are lossless by default, so a
   * host that stored a message gets exactly that message back.
   */
  #inline(message: SessionMessage): SessionMessage {
    return resolveAttachments(message, (hash) => this.#attachments.get(hash));
  }

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
