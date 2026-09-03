/**
 * @internal Storage engine behind the Sessions capability. One instance per
 * capability, owning the `cf_agents_session_*` tables. All methods assume the
 * caller has settled startup ordering (`lifecycle.ready()` for public API).
 *
 * Write economics: rows written cost ~1000× rows read on DO SQLite. Every
 * table is WITHOUT ROWID with no secondary index, so one row write bills one
 * row. State is derived from existing rows, never kept in counter rows, and
 * an unchanged update writes nothing. The only in-memory state is the tail
 * of each session (its leaf id and next `seq`), read once per object
 * lifetime because finding it means scanning the session's rows.
 */

import { extractAttachments, resolveAttachments } from "./attachment-ingest";
import { AttachmentStore } from "./attachment-store";
import { splitContent } from "./chunking";
import type { SessionsIo } from "./io";
import { overlayMessage, planOverlays } from "./overlays";
import {
  estimateAttachmentTokens,
  estimatedDataUrlBytes,
  estimateMessageTokens,
  estimateStringTokens
} from "./tokens";
import type {
  HistoryReadOptions,
  RecentHistoryResult,
  SearchResult,
  SessionChangeEvent,
  SessionChangeListener,
  SessionMessage,
  SessionRowStat,
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

/**
 * Deepest path a history read follows. A read of a longer branch sees its
 * most recent rows only, and `getRecentHistory` reports that as truncated.
 */
const MAX_PATH_DEPTH = 10_000;

/** The newest row of a session: what an append attaches to and numbers from. */
type Tail = { leafId: string | null; nextSeq: number };

export type UpdateOutcome = "missing" | "unchanged" | "updated";

export class SessionsCore {
  readonly io: SessionsIo;
  readonly #reservedMetadataKeys: readonly string[];
  readonly #listeners = new Set<SessionChangeListener>();
  readonly #tails = new Map<string, Tail>();
  readonly #attachments: AttachmentStore;
  #tablesEnsured = false;
  /** True once the FTS index exists; it is built on the first `search()`. */
  #fts = false;

  constructor(options: SessionsOptions, io: SessionsIo) {
    this.io = io;
    this.#attachments = new AttachmentStore(io);
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
    this.#fts = this.#tableExists("cf_agents_session_fts");
    this.#tablesEnsured = true;
  }

  #tableExists(name: string): boolean {
    return (
      this.io.sql<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        [name]
      ).length > 0
    );
  }

  /**
   * Build the FTS index on demand. Maintaining it costs an extra billed row
   * on every append, so it exists only on objects that have actually
   * searched; the first search pays a one-time SQL backfill instead.
   */
  #ensureFts(): void {
    if (this.#fts) return;
    this.io.sqlWrite(
      `CREATE VIRTUAL TABLE cf_agents_session_fts
       USING fts5(id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content, tokenize='porter unicode61')`,
      []
    );
    this.#fts = true;
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
   * Lift the legacy `assistant_*` message and compaction tables.
   *
   * The copy is pure SQL, so SQLite streams it rather than materializing rows
   * in the isolate. Each source is then verified row by row against its
   * destination and DROPPED: keeping tombstones would leave every upgraded
   * object holding its history twice inside the same 10 GB. A table whose
   * verification fails is left in place with a `session:migration:incomplete`
   * event, and the method returns false so the caller leaves the schema
   * version unstamped and retries on a later start. `assistant_config`
   * belongs to Think, which lifts and drops it itself.
   */
  migrateLegacy(): boolean {
    let complete = true;
    const drop = (name: string): void => {
      if (this.#tableExists(name)) this.io.sqlWrite(`DROP TABLE ${name}`, []);
    };
    /**
     * Drop a lifted source only once every one of its rows has a copy holding
     * the same payload. Matching on the key alone would accept a destination
     * row that merely occupies the key.
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

    if (this.#tableExists("assistant_messages")) {
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
      if (this.#fts) this.#backfillMissingFtsRows();
      dropWhenCopied(
        "assistant_messages",
        "cf_agents_session_messages",
        "content"
      );
    }
    if (this.#tableExists("assistant_compactions")) {
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
    // Neither carries data the new schema needs: session summaries derive
    // from message rows, and the index is rebuilt from message text on the
    // first search.
    drop("assistant_sessions");
    drop("assistant_fts");
    return complete;
  }

  // ── Change feed ──────────────────────────────────────────────────────────

  subscribe(listener: SessionChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Dispatch after a durable write. A listener that throws must not turn a
   * committed write into a rejected call, so failures are reported through
   * telemetry and dispatch continues.
   */
  async notify(event: SessionChangeEvent): Promise<void> {
    for (const listener of this.#listeners) {
      try {
        await listener(event);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[Sessions] change listener failed: ${detail}`);
        this.io.emit("session:error", {
          sessionId: event.sessionId,
          event: event.type,
          error: detail
        });
      }
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

  exists(sessionId: string, id: string): boolean {
    return (
      this.io.sql<{ id: string }>(
        "SELECT id FROM cf_agents_session_messages WHERE session_id = ? AND id = ?",
        [sessionId, id]
      ).length > 0
    );
  }

  getMessage(sessionId: string, id: string): SessionMessage | null {
    const content = this.#content(sessionId, id);
    const parsed = content === null ? null : this.#parse(content);
    return parsed && this.#inline(parsed);
  }

  /**
   * The session's newest row. Children insert after their parents, so the
   * max-seq row is provably childless: it is the active leaf, and the next
   * append numbers from it. Read once per object lifetime, since the table
   * is keyed by id and finding the max means scanning the session's rows.
   */
  #tail(sessionId: string): Tail {
    const cached = this.#tails.get(sessionId);
    if (cached) return cached;
    const [row] = this.io.sql<{ id: string; seq: number }>(
      "SELECT id, seq FROM cf_agents_session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
      [sessionId]
    );
    const tail: Tail = row
      ? { leafId: row.id, nextSeq: row.seq + 1 }
      : { leafId: null, nextSeq: 1 };
    this.#tails.set(sessionId, tail);
    return tail;
  }

  latestLeafId(sessionId: string): string | null {
    return this.#tail(sessionId).leafId;
  }

  #resolveLeafId(sessionId: string, leafId?: string | null): string | null {
    if (leafId) return this.exists(sessionId, leafId) ? leafId : null;
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
   * it points at, charged at the size they take once inlined, so a byte
   * budget over these rows bounds real hydrated memory.
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
        WHERE m.session_id = ? AND p.depth < ${MAX_PATH_DEPTH}
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
    rows: readonly SessionRowStat[]
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
      if (parsed) result.set(row.id, this.#inline(parsed));
    }
    return result;
  }

  /** Stream a known path window without retaining earlier content chunks. */
  async *#streamStats(
    sessionId: string,
    stats: readonly SessionRowStat[],
    signal?: AbortSignal
  ): AsyncGenerator<SessionMessage, void, undefined> {
    const spans = planOverlays(
      stats.map((row) => row.id),
      this.getCompactions(sessionId)
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
    yield* this.#streamStats(sessionId, stats, options.signal);
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
   *
   * There is no message-count floor: one used to exist, and it admitted
   * rows regardless of size, so a window of media-heavy messages could
   * hydrate far past the limit meant to bound it. The newest message is
   * always returned even if it alone exceeds the budget, since returning
   * nothing is worse. Overlays whose anchors fall outside the window are
   * skipped, showing the raw recent messages.
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
      stats.slice(start)
    )) {
      messages.push(message);
    }
    // The path cap hides older rows exactly as the budget does, so a branch
    // deeper than the cap is truncated whatever the budget admitted.
    return {
      messages,
      truncated: start > 0 || stats.length > MAX_PATH_DEPTH,
      totalContentBytes
    };
  }

  /**
   * Heuristic token estimate for the active path with compaction overlays
   * applied: stamped per-row estimates, minus compacted spans, plus their
   * summaries. Derived from content-free rows on each call; it gates cheap
   * triggers only, and model-reported usage stays authoritative.
   */
  tokenEstimate(sessionId: string): number {
    const stats = this.pathRowStats(sessionId);
    let tokens = stats.reduce((sum, row) => sum + row.tokenEstimate, 0);
    for (const span of planOverlays(
      stats.map((row) => row.id),
      this.getCompactions(sessionId)
    )) {
      for (let i = span.startIndex; i <= span.endIndex; i++) {
        tokens -= stats[i].tokenEstimate;
      }
      tokens += estimateStringTokens(span.compaction.summary);
    }
    return Math.max(0, Math.ceil(tokens));
  }

  // ── Writes ───────────────────────────────────────────────────────────────

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
   * continuation, attachment, and FTS rows commit in one synchronous SQLite
   * transaction. Returns the stored message: the input itself when it was
   * inserted (extraction is lossless, so the two are identical), or the row
   * already holding the id when it was not.
   */
  append(
    sessionId: string,
    message: SessionMessage,
    parentId: string | null | undefined,
    tokenEstimate: number
  ): { inserted: boolean; message: SessionMessage } {
    const existing = this.getMessage(sessionId, message.id);
    if (existing) return { inserted: false, message: existing };

    // `undefined` attaches to the tail and needs no validation read. A
    // caller-supplied id is untrusted and falls back to a root append when
    // it does not belong to this session.
    const tail = this.#tail(sessionId);
    let parent: string | null;
    if (parentId === undefined) {
      parent = tail.leafId;
    } else {
      parent = parentId && this.exists(sessionId, parentId) ? parentId : null;
    }

    // Inline media leaves the message before it is serialized, so the row
    // holds a pointer and never the payload. Addresses are computed here, out
    // of the transaction; the transaction only writes.
    const { message: staged, attachments } = extractAttachments(message);
    const slices = splitContent(JSON.stringify(staged));
    const seq = tail.nextSeq;
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
          Date.now()
        ]
      );
      this.#writeContinuations(sessionId, message.id, slices);
      this.#attachments.addRefs(
        sessionId,
        message.id,
        attachments.map((attachment) => attachment.hash)
      );
      this.#indexFts(sessionId, staged, false);
    });

    // The freshly inserted row is the most recent childless node, so it is
    // now the latest leaf — true even for an explicit-parent branch append.
    this.#tails.set(sessionId, { leafId: message.id, nextSeq: seq + 1 });
    this.io.emit("session:message:appended", {
      sessionId,
      messageId: message.id,
      tokenEstimate
    });
    return { inserted: true, message };
  }

  /**
   * Durable update of an existing row. An identical row writes nothing: no
   * row, no continuation, no FTS, no event. The no-op guard compares the
   * FULL reassembled content, not just the slice the message row holds.
   */
  update(
    sessionId: string,
    message: SessionMessage,
    tokenEstimate: number
  ): UpdateOutcome {
    const oldRows = this.io.sql<{ content: string; content_chunks: number }>(
      "SELECT content, content_chunks FROM cf_agents_session_messages WHERE session_id = ? AND id = ?",
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
    const json = JSON.stringify(staged);
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
        attachments.map((attachment) => attachment.hash)
      );
      this.#indexFts(sessionId, staged, true);
    });
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
  deleteMessages(sessionId: string, messageIds: string[]): void {
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
      if (this.#fts) {
        this.io.sqlWrite(
          `DELETE FROM cf_agents_session_fts
           WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
          [sessionId, ids]
        );
      }
    });
    // The leaf may be among the deleted rows; re-derive on the next append.
    this.#tails.delete(sessionId);
    this.io.emit("session:messages:deleted", {
      sessionId,
      count: uniqueIds.length
    });
  }

  clearMessages(sessionId: string): void {
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
      if (this.#fts) {
        this.io.sqlWrite(
          "DELETE FROM cf_agents_session_fts WHERE session_id = ?",
          [sessionId]
        );
      }
    });
    this.#tails.set(sessionId, { leafId: null, nextSeq: 1 });
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
    this.#ensureFts();
    // Quote the query as a literal phrase, escaping embedded double quotes,
    // so user input cannot inject FTS5 syntax.
    const sanitized = `"${query.replace(/"/g, '""')}"`;
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
  }

  /** Maintain the FTS row when the index exists; an unchanged text writes nothing. */
  #indexFts(
    sessionId: string,
    message: SessionMessage,
    replace: boolean
  ): void {
    if (!this.#fts) return;
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

  // ── Import ───────────────────────────────────────────────────────────────

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
    const slices = splitContent(JSON.stringify(staged));
    const tail = this.#tail(sessionId);
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
          tail.nextSeq,
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
        attachments.map((attachment) => attachment.hash)
      );
      this.#indexFts(sessionId, staged, false);
    });
    if (inserted === 0) return;
    this.#tails.set(sessionId, {
      leafId: message.id,
      nextSeq: tail.nextSeq + 1
    });
  }

  // ── Parsing ──────────────────────────────────────────────────────────────

  /** Put attachment payloads back inline, so a read returns what was written. */
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
