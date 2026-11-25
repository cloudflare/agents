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

import { createHash } from "node:crypto";
import { extractAttachments, resolveAttachments } from "./attachment-ingest";
import { AttachmentStore } from "./attachment-store";
import { splitContent } from "./chunking";
import { COMPACTION_PREFIX } from "./compaction-helpers";
import type { SessionsIo } from "./io";
import { overlayMessage } from "./overlays";
import {
  estimateAttachmentTokens,
  estimatedDataUrlBytes,
  estimateMessageTokens,
  estimateStringTokens
} from "./tokens";
import type {
  HistoryReadOptions,
  LegacyFlatMessages,
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
 * The compactions table, keyed by where an overlay ends, so "does an
 * overlay end at this row" is a primary-key probe. `resume_id` is the row
 * the visible path continues at below the overlay: `''` for the root, NULL
 * while not yet derived (a row written by an earlier release). An overlay
 * applies only once `resume_id` is known. Same name and the same columns as
 * before schema version 2 plus one, so an earlier release still reads and
 * writes it after a rollback.
 */
const COMPACTIONS_COLUMNS = `
  session_id TEXT NOT NULL,
  to_message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  summary TEXT NOT NULL,
  from_message_id TEXT NOT NULL,
  resume_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, to_message_id, seq)`;

/**
 * Session size at which the message table gets a `(session_id, seq)` index
 * for finding the newest row (`#tail`). Derived from prices, not tuned:
 *
 * - Without the index, each wake and each delete finds the tail by scanning
 *   the session: 2N rows read for N stored rows.
 * - With it, the tail is one row, but every append writes one more row, and
 *   a row written costs about R = 1,000 rows read. Building it writes about
 *   N rows once, R x N.
 * - A wake appends about A = 3 rows (the user message, the reply, a tool
 *   row). Assume a session has as many wakes ahead as it has had, N / A.
 *
 * The index pays when (N / A) x (2N - A x R) > R x N, that is N > A x R =
 * 3,000. Below it a session never pays a write for an index it does not
 * need, which is most sessions. The answer is the same with or without it.
 */
const TAIL_INDEX_ROWS = 3 * 1_000;

/**
 * Session config keys under this prefix belong to the transcript and are
 * deleted by `clearMessages`; every other key survives a clear. The end
 * bound is the prefix with its last character incremented (`:` + 1 = `;`),
 * so the delete is a primary-key range.
 */
const TRANSCRIPT_CONFIG_PREFIX = "transcript:";
const TRANSCRIPT_CONFIG_PREFIX_END = "transcript;";
/** Session config key `clearMessages()` sets to the time of the clear. */
const CLEARED_AT_CONFIG_KEY = "session:cleared-at";

/**
 * First batch of a newest-first annotation lookup: the record it looks for
 * is usually within the newest few messages.
 */
const NEWEST_FIRST_WINDOW_ROWS = 8;

/** Steps one walk statement takes before the reader asks for the next batch. */
const WALK_BATCH_STEPS = 512;

/**
 * What a byte-budgeted read charges each message beyond its stored bytes.
 * A parsed message holds its JSON as UTF-16 strings plus the objects for
 * the message and its parts, so a budget over stored bytes alone admits
 * any number of tiny messages: 32 MiB took 190,570 messages of 100 bytes
 * on a deployment, a prompt the object could not build without being
 * reset. Charging 1 KiB per message bounds the count as well: at most
 * 32,768 messages under 32 MiB. A bound, stated here, not a measurement.
 */
const RECENT_MESSAGE_OVERHEAD_BYTES = 1024;

/**
 * What one `compact()` round hands the compaction function at most: the
 * oldest visible messages within this many bytes (each charged
 * `RECENT_MESSAGE_OVERHEAD_BYTES` on top). One history chunk: a compaction
 * function gets the part in one call, and a summarizer can't use more than
 * a model's context. A larger part means fewer rounds for a session that
 * never compacted, but a summary call that fails makes no progress.
 */
export const COMPACT_INPUT_BYTES = 4 * 1024 * 1024;

/** First batch of a byte-budgeted read: most budgets stop within it. */
const RECENT_FIRST_BATCH_STEPS = 64;

/**
 * Bound on root-first whole-path reads (`getHistory()`, `history()`,
 * `getHistoryRowStats()`). They hold one entry per visible message before
 * any content is read; 200,000 keeps that list near 16 MiB in a 128 MB
 * isolate that a facet tree shares. Past it the read throws: it never
 * returns a shorter path. Newest-first and byte-budgeted reads hold only
 * what they return and have no bound.
 */
const MAX_ROOT_FIRST_STEPS = 200_000;

/**
 * Ids bound per statement in `deleteMessages`. One bound value holds about
 * 300,000 ids before `SQLITE_TOOBIG` in production (measured); older local
 * runtimes cap a value at about 2.2 MB, which 20,000 ids stay well under.
 */
const DELETE_BATCH_IDS = 20_000;

/**
 * The error a root-first read throws past `MAX_ROOT_FIRST_STEPS`. Named
 * `SessionPathTooLongError` so a caller can recognise it by `name`; the
 * message says how to read the path instead.
 */
function pathTooLong(leafId: string | null | undefined): Error {
  const error = new Error(
    `Sessions: the path${leafId ? ` to "${leafId}"` : ""} holds more than ` +
      `${MAX_ROOT_FIRST_STEPS.toLocaleString("en-US")} visible messages, too many to read root-first. ` +
      "Read it newest-first with history({ newestFirst: true }), use " +
      "getRecentHistory(), or compact the session."
  );
  error.name = "SessionPathTooLongError";
  return error;
}

/**
 * SQL for the bytes a message row costs once hydrated: the row, its
 * continuation rows, and the payloads it points at, charged at the size
 * they take once inlined, so a byte budget bounds real memory. `am` is the
 * message row.
 */
function rowBytesSql(t: SessionTables): string {
  return `(LENGTH(CAST(am.content AS BLOB)) + CASE WHEN am.content_chunks = 0 THEN 0
    ELSE COALESCE((
      SELECT SUM(LENGTH(CAST(c.content AS BLOB)))
      FROM ${t.chunks} c
      WHERE c.session_id = am.session_id AND c.id = am.id
    ), 0) END
  + COALESCE((
      SELECT SUM((meta.bytes + 2) / 3 * 4)
      FROM ${t.attachmentRefs} r
      JOIN ${t.attachmentMeta} meta ON meta.hash = r.hash
      WHERE r.session_id = am.session_id AND r.message_id = am.id
    ), 0))`;
}

/** Bounds for one window of a legacy flat-table lift: rows and summed bytes. */
const LEGACY_LIFT_WINDOW_ROWS = 25;
const LEGACY_LIFT_WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * Hidden overlay rows: a stored `compaction_<id>` row whose `<id>` names one
 * of the session's own compaction records, so it duplicates an overlay the
 * session renders itself. Writes refuse overlays, but sessions written before
 * that guard (#1984) can hold one, usually with later rows parented to it.
 * Reads skip such a row and walk through it, so its children take its place.
 * A `compaction_` row with no matching record, such as a summary imported
 * from another session's history, is the only copy of that context and stays
 * visible.
 */
function hasOverlayPrefix(id: string): boolean {
  return id.startsWith(COMPACTION_PREFIX);
}

/**
 * SQL twin of the hidden-overlay test for the row id in `idColumn` of the
 * session in `sessionExpr`. The record lookup runs only for prefixed ids.
 * Both must be table-qualified: inside the lookup an unqualified `id` or
 * `session_id` binds to the compactions table, not the row being tested.
 */
function hiddenOverlayRowSql(
  t: SessionTables,
  idColumn: string,
  sessionExpr: string
): string {
  const length = COMPACTION_PREFIX.length;
  return `(substr(${idColumn}, 1, ${length}) = '${COMPACTION_PREFIX}'
    AND EXISTS (SELECT 1 FROM ${t.compactions} oc
      WHERE oc.session_id = ${sessionExpr}
        AND oc.id = substr(${idColumn}, ${length + 1})))`;
}

/** What a hydration window needs from a path row: its id, and its stored size when the window is byte-bounded. */
type PathRow = { id: string; bytes: number };

/** The newest row of a session: what an append attaches to and numbers from. */
/**
 * A session's newest row and the next `seq`. While the tail index doesn't
 * exist, `rows` is an upper bound on the session's stored rows (its newest
 * `seq` at first, then exact once counted); `null` once the index exists.
 * Rows are counted only when the bound reaches `TAIL_INDEX_ROWS`.
 */
type Tail = { leafId: string | null; nextSeq: number; rows: number | null };

/**
 * The memoised context-size estimate for a session: the leaf it was
 * computed for and the total along the visible walk. A tail append and an
 * update of that leaf adjust it in place; every other write drops it, and
 * the next `tokenEstimate` re-derives it from one walk. Two fields per
 * session, whatever the path length.
 */
type PathTokens = { leafId: string | null; total: number };

/** One step of the visible walk (see `SessionsCore.#walk`). */
type VisibleStep = {
  id: string;
  role: string;
  tokenEstimate: number;
  /** The `seq` of the overlay that ends at this row and applies, or null. */
  overlaySeq: number | null;
  overlayId: string | null;
  /** Where the walk continues: the parent, or the overlay's `resume_id`. */
  next: string | null;
  /** A legacy stored overlay row: walked through, never shown. */
  hidden: boolean;
  /** Hydrated size, when the walk measured. */
  bytes?: number;
};

type CompactionRow = {
  id: string;
  summary: string;
  from_message_id: string;
  to_message_id: string;
  created_at: number;
};

function toStoredCompaction(row: CompactionRow): StoredCompaction {
  return {
    id: row.id,
    summary: row.summary,
    fromMessageId: row.from_message_id,
    toMessageId: row.to_message_id,
    createdAt: new Date(row.created_at).toISOString()
  };
}

export type UpdateOutcome = "missing" | "unchanged" | "updated";

/**
 * Digest of a message's stored form, stamped on the row by every write, so an
 * update can decide "unchanged" without reading the stored content back.
 */
function contentDigest(json: string): string {
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/**
 * The text a message contributes to the search index. The index holds it in
 * one row, so only the first row budget is searchable; the rest would not
 * fit (`SQLITE_TOOBIG`). A cut inside a word is moved back to before the
 * last separator, so no fragment is indexed as if it were a word. A word is
 * what the index's `unicode61` tokenizer keeps together: letters, digits,
 * combining marks and private-use characters, read by code point.
 */
function searchableText(message: SessionMessage): string {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join(" ");
  const first = splitContent(text)[0] ?? "";
  const next = text.codePointAt(first.length);
  if (next === undefined || !SEARCH_WORD.test(String.fromCodePoint(next))) {
    return first;
  }
  const cut = lastSeparator(first);
  return cut > 0 ? first.slice(0, cut) : first;
}

/** A character the `unicode61` tokenizer keeps inside a word. */
const SEARCH_WORD = /[\p{L}\p{N}\p{M}\p{Co}]/u;

/**
 * @internal Exported for its tests. The index of the last separator in
 * `text` (the character before its final word), or -1 when `text` is one
 * word. Scans back one code point at a time: a regex anchored at the end
 * backtracks and runs out of stack on a slice of several megabytes.
 */
export function lastSeparator(text: string): number {
  for (let end = text.length; end > 0;) {
    let start = end - 1;
    const low = text.charCodeAt(start);
    if (low >= 0xdc00 && low <= 0xdfff && start > 0) {
      const high = text.charCodeAt(start - 1);
      if (high >= 0xd800 && high <= 0xdbff) start--;
    }
    if (!SEARCH_WORD.test(text.slice(start, end))) return start;
    end = start;
  }
  return -1;
}

/**
 * The search index's own marker, a row at a fixed rowid with no text (it
 * never matches): present once every message stored across continuation
 * rows is indexed. An index built by an earlier release, which skipped those
 * messages, has none, and gets them on its first search here. Read by rowid.
 */
const SEARCH_BACKFILLED_ROWID = -1;
const SEARCH_MARKER_SESSION = "\u0000search";

/**
 * The real names of one Sessions instance's tables and index. The default
 * instance's are today's names; a named instance's carry its suffix
 * (`LifecycleCapability.store`). Resolved once, then built into statement
 * text.
 */
export interface SessionTables {
  messages: string;
  chunks: string;
  compactions: string;
  /** The schema-v2 rebuild's temporary table. */
  compactionsRebuild: string;
  config: string;
  annotations: string;
  fts: string;
  attachmentMeta: string;
  attachmentChunks: string;
  attachmentRefs: string;
  /** The `(session_id, seq)` tail index (an index, so database-wide). */
  tailIndex: string;
}

/** The tables of the instance whose store maps `name` to a table name. */
export function sessionTables(table: (name: string) => string): SessionTables {
  return {
    messages: table("session_messages"),
    chunks: table("session_message_chunks"),
    compactions: table("session_compactions"),
    compactionsRebuild: table("session_compactions_v2"),
    config: table("session_config"),
    annotations: table("session_annotations"),
    fts: table("session_fts"),
    attachmentMeta: table("session_attachment_meta"),
    attachmentChunks: table("session_attachment_chunks"),
    attachmentRefs: table("session_attachment_refs"),
    // Today's name for the default (not the store's `idx_` form), with the
    // instance suffix for a named one: an index name is database-wide.
    tailIndex: table("session_messages_by_seq")
  };
}

/** The default instance's tables. */
export const DEFAULT_SESSION_TABLES = sessionTables(
  (name) => `cf_agents_${name}`
);

export class SessionsCore {
  readonly io: SessionsIo;
  readonly #reservedMetadataKeys: readonly string[];
  readonly #listeners = new Set<SessionChangeListener>();
  readonly #tails = new Map<string, Tail>();
  readonly #pathTokens = new Map<string, PathTokens>();
  readonly #attachments: AttachmentStore;
  #tablesEnsured = false;
  /** True once the FTS index exists; it is built on the first `search()`. */
  #fts = false;
  /** True once this isolate knows every split message is in the index. */
  #ftsBackfilled = false;
  /** True once the tail index is known to exist in this isolate. */
  #tailIndexed = false;
  /** True once building the tail index failed in this isolate. */
  #tailIndexFailed = false;

  /** This instance's table and index names. */
  readonly #t: SessionTables;

  constructor(
    options: SessionsOptions,
    io: SessionsIo,
    tables: SessionTables = DEFAULT_SESSION_TABLES
  ) {
    this.io = io;
    this.#t = tables;
    this.#attachments = new AttachmentStore(io, tables);
    this.#reservedMetadataKeys = options.reservedMetadataKeys ?? [];
    this.#legacyFlatMessages = options.legacyFlatMessages;
  }

  readonly #legacyFlatMessages: LegacyFlatMessages | undefined;

  // ── Schema ───────────────────────────────────────────────────────────────

  ensureTables(): void {
    if (this.#tablesEnsured) return;
    this.io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS ${this.#t.messages} (
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
        content_hash TEXT,
        PRIMARY KEY (session_id, id)
      ) WITHOUT ROWID`,
      []
    );
    this.#addMessageContentHashColumn();
    this.io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS ${this.#t.chunks} (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (session_id, id, idx)
      ) WITHOUT ROWID`,
      []
    );
    this.io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS ${this.#t.compactions} (${COMPACTIONS_COLUMNS}) WITHOUT ROWID`,
      []
    );
    this.io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS ${this.#t.config} (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      ) WITHOUT ROWID`,
      []
    );
    this.io.sqlWrite(
      `CREATE TABLE IF NOT EXISTS ${this.#t.annotations} (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id, kind)
      ) WITHOUT ROWID`,
      []
    );
    this.#attachments.ensureTables();
    this.#fts = this.#tableExists(`${this.#t.fts}`);
    this.#tablesEnsured = true;
  }

  /**
   * Add the digest column to a message table that predates it. Nullable, so
   * no existing row is rewritten; a `null` digest falls back to reading the
   * row back once.
   */
  #addMessageContentHashColumn(): void {
    const columns = this.io
      .sql<{
        name: string;
      }>(`SELECT name FROM pragma_table_info('${this.#t.messages}')`, [])
      .map((row) => row.name);
    if (columns.includes("content_hash")) return;
    this.io.sqlWrite(
      `ALTER TABLE ${this.#t.messages} ADD COLUMN content_hash TEXT`,
      []
    );
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
    if (this.#fts) {
      if (!this.#ftsBackfilled) {
        const marked =
          this.io.sql<{ one: number }>(
            `SELECT 1 AS one FROM ${this.#t.fts} WHERE rowid = ?`,
            [SEARCH_BACKFILLED_ROWID]
          ).length > 0;
        // An index from an earlier release, or a backfill cut short: some
        // split messages may already be indexed (appends since), so check.
        if (!marked) this.#backfillSplitMessages(true);
        this.#ftsBackfilled = true;
      }
      return;
    }
    this.io.sqlWrite(
      `CREATE VIRTUAL TABLE ${this.#t.fts}
       USING fts5(id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content, tokenize='porter unicode61')`,
      []
    );
    this.#fts = true;
    this.#backfillMissingFtsRows();
    this.#backfillSplitMessages(false);
    this.#ftsBackfilled = true;
  }

  /**
   * Index the messages stored across continuation rows. Their first slice
   * is not valid JSON on its own, so the SQL backfill skips them; each is
   * indexed from its reassembled JSON (attachments are not loaded: the
   * index holds text), one message in memory at a time. On a new index
   * none of them is there yet; on an older one, `check` skips those already
   * indexed. The marker row goes in last, so a backfill cut short is
   * finished by a later search.
   */
  #backfillSplitMessages(check: boolean): void {
    const split = this.io.sql<{ session_id: string; id: string }>(
      `SELECT session_id, id FROM ${this.#t.messages} WHERE content_chunks > 0`,
      []
    );
    // Which split messages an older index already holds: one scan of the
    // index for all of them (its id columns are not indexed).
    const indexed = new Set<string>();
    if (check && split.length > 0) {
      for (const row of this.io.sql<{ session_id: string; id: string }>(
        `SELECT session_id, id FROM ${this.#t.fts}
         WHERE id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(split.map((row) => row.id))]
      )) {
        indexed.add(`${row.session_id}\u0000${row.id}`);
      }
    }
    for (const { session_id: sessionId, id } of split) {
      if (indexed.has(`${sessionId}\u0000${id}`)) continue;
      const json = this.#content(sessionId, id);
      const message = json === null ? null : this.#parse(json);
      if (message) this.#indexFts(sessionId, message, false);
    }
    this.io.sqlWrite(
      `INSERT INTO ${this.#t.fts} (rowid, id, session_id, role, content)
       VALUES (?, '', ?, '', '')`,
      [SEARCH_BACKFILLED_ROWID, SEARCH_MARKER_SESSION]
    );
  }

  /** Index rows that predate indexing, in SQL, without loading JSON into JS. */
  #backfillMissingFtsRows(): void {
    this.io.sqlWrite(
      `INSERT INTO ${this.#t.fts} (id, session_id, role, content)
       SELECT m.id, m.session_id, m.role,
         group_concat(json_extract(part.value, '$.text'), ' ')
       FROM ${this.#t.messages} AS m
       JOIN json_each(
         CASE WHEN json_valid(m.content) THEN m.content ELSE '{"parts":[]}' END,
         '$.parts'
       ) AS part
       WHERE json_extract(part.value, '$.type') = 'text'
         AND COALESCE(json_extract(part.value, '$.text'), '') <> ''
         AND NOT EXISTS (
           SELECT 1 FROM ${this.#t.fts} AS existing
           WHERE existing.id = m.id AND existing.session_id = m.session_id
         )
       GROUP BY m.id, m.session_id, m.role`,
      []
    );
  }

  /**
   * Schema version 2: rebuild the compactions table keyed by its end, with
   * `resume_id` (NULL until derived). Every row is copied, summaries
   * included. A no-op on a table that already has the column, so a start
   * interrupted after the rebuild repeats nothing.
   */
  rebuildCompactions(): void {
    const rebuilt =
      this.io.sql<{ one: number }>(
        `SELECT 1 AS one FROM pragma_table_info('${this.#t.compactions}')
         WHERE name = 'resume_id'`,
        []
      ).length > 0;
    if (rebuilt) return;
    this.io.transaction(() => {
      this.io.sqlWrite(
        `CREATE TABLE ${this.#t.compactionsRebuild} (${COMPACTIONS_COLUMNS}) WITHOUT ROWID`,
        []
      );
      this.io.sqlWrite(
        `INSERT INTO ${this.#t.compactionsRebuild}
          (session_id, to_message_id, seq, id, summary, from_message_id, resume_id, created_at)
         SELECT session_id, to_message_id, seq, id, summary, from_message_id, NULL, created_at
         FROM ${this.#t.compactions}`,
        []
      );
      this.io.sqlWrite(`DROP TABLE ${this.#t.compactions}`, []);
      this.io.sqlWrite(
        `ALTER TABLE ${this.#t.compactionsRebuild} RENAME TO ${this.#t.compactions}`,
        []
      );
    });
  }

  /**
   * Derive `resume_id` for overlays that have none: rows from before schema
   * version 2, and rows an earlier release wrote after a rollback. Runs on
   * every start; normally it finds no row. An overlay is derived only when
   * its start and end rows exist and the start is not newer than the end;
   * for the newest pending overlay of each session the start must also be
   * an ancestor of the end. The rest stay NULL and never apply, as they
   * never applied before. Nothing is deleted: `getCompactions()` lists them,
   * and their count is reported in `session:overlays:unresolved`.
   */
  resolveOverlays(): void {
    const pending = this.io.sql<{
      session_id: string;
      to_message_id: string;
      seq: number;
      from_message_id: string;
      from_seq: number | null;
      from_parent: string | null;
      to_seq: number | null;
    }>(
      `SELECT c.session_id, c.to_message_id, c.seq, c.from_message_id,
         f.seq AS from_seq, f.parent_id AS from_parent, t.seq AS to_seq
       FROM ${this.#t.compactions} c
       LEFT JOIN ${this.#t.messages} f
         ON f.session_id = c.session_id AND f.id = c.from_message_id
       LEFT JOIN ${this.#t.messages} t
         ON t.session_id = c.session_id AND t.id = c.to_message_id
       WHERE c.resume_id IS NULL`,
      []
    );
    if (pending.length === 0) return;
    // Every derived overlay's start must be an ancestor of its end, or the
    // walk would continue on another branch. The checks are reads (a walk
    // can cover a long span), so they run before the transaction. Overlays
    // are grouped by start: one walk up from the highest end decides every
    // end it passes (they are on that path), which is one walk for a whole
    // chain of `compact()` overlays.
    type Pending = (typeof pending)[number];
    const groups = new Map<string, Pending[]>();
    for (const row of pending) {
      if (
        row.from_seq === null ||
        row.to_seq === null ||
        row.from_seq > row.to_seq
      ) {
        continue;
      }
      const key = `${row.session_id}\u0000${row.from_message_id}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const resolved: Pending[] = [];
    for (const group of groups.values()) {
      const remaining = group.sort((a, b) => (b.to_seq ?? 0) - (a.to_seq ?? 0));
      while (remaining.length > 0) {
        const top = remaining[0];
        const from = top.from_message_id;
        const hits = new Set(
          this.io
            .sql<{ id: string }>(
              `WITH RECURSIVE up(id, parent_id) AS (
                SELECT id, parent_id FROM ${this.#t.messages}
                WHERE session_id = ?1 AND id = ?2
                UNION ALL
                SELECT m.id, m.parent_id FROM up
                CROSS JOIN ${this.#t.messages} m
                  ON m.session_id = ?1 AND m.id = up.parent_id
                WHERE up.id <> ?3 AND m.seq >= ?4
              )
              SELECT id FROM up WHERE id IN (SELECT value FROM json_each(?5))`,
              [
                top.session_id,
                top.to_message_id,
                from,
                top.from_seq,
                JSON.stringify([from, ...remaining.map((r) => r.to_message_id)])
              ]
            )
            .map((row) => row.id)
        );
        const onPath = (row: Pending) =>
          row === top || hits.has(row.to_message_id);
        if (hits.has(from)) resolved.push(...remaining.filter(onPath));
        // Off this path: a later walk from the next highest end decides.
        const rest = remaining.filter((row) => !onPath(row));
        remaining.splice(0, remaining.length, ...rest);
      }
    }
    const unresolved = pending.length - resolved.length;
    this.io.transaction(() => {
      for (const row of resolved) {
        this.io.sqlWrite(
          `UPDATE ${this.#t.compactions} SET resume_id = ?
           WHERE session_id = ? AND to_message_id = ? AND seq = ?`,
          [row.from_parent ?? "", row.session_id, row.to_message_id, row.seq]
        );
        this.#pathTokens.delete(row.session_id);
      }
    });
    if (unresolved > 0) {
      this.io.emit("session:overlays:unresolved", { count: unresolved });
    }
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
    this.#pathTokens.clear();
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
        `INSERT OR IGNORE INTO ${this.#t.messages}
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
      dropWhenCopied("assistant_messages", `${this.#t.messages}`, "content");
    }
    if (this.#tableExists("assistant_compactions")) {
      this.io.sqlWrite(
        `INSERT OR IGNORE INTO ${this.#t.compactions}
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
        `${this.#t.compactions}`,
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

  /**
   * Lift the configured flat legacy table into the default session.
   *
   * Order is read first as ids and sizes alone, then bodies are fetched in
   * windows bounded by row count and bytes, so a large transcript never sits
   * in the isolate at once, and no query binds more than one window of ids.
   * The table is dropped only when every row has a copy holding the same
   * payload: a row that cannot be parsed, or whose id another message holds,
   * keeps it, and the next start tries again (`importMessage` ignores ids it
   * already has).
   *
   * @returns `false` when rows were left behind.
   */
  liftLegacyFlatMessages(): boolean {
    const source = this.#legacyFlatMessages;
    if (!source || !this.#tableExists(source.table)) return true;
    const { table } = source;
    const order = this.io
      .sql<{
        id: string;
        bytes: number;
        created_at: string | number | null;
      }>(
        `SELECT id, LENGTH(CAST(message AS BLOB)) AS bytes, created_at
         FROM ${table}
         ORDER BY created_at ASC, rowid ASC`,
        []
      )
      .map((row, index) => ({ ...row, index }));
    const parse = (body: string, id: string): SessionMessage | undefined => {
      try {
        return source.parse(JSON.parse(body), id);
      } catch {
        return undefined;
      }
    };

    // Rows an earlier start already lifted: present under their id with
    // the same payload. A row that lands now must not go before one of
    // them: importing it would fork the chain, and the rows after it would
    // leave the active path. Such a row stays in the table, recoverable.
    const present = new Set(
      this.io
        .sql<{ id: string }>(
          `SELECT legacy.id AS id FROM ${table} AS legacy
           JOIN ${this.#t.messages} AS lifted
             ON lifted.session_id = '' AND lifted.id = legacy.id`,
          []
        )
        .map((row) => row.id)
    );
    const copies = new Set<string>();
    let lastLifted = -1;
    if (present.size > 0) {
      this.#forEachLegacyRow(
        table,
        order.filter((row) => present.has(row.id)),
        (row, body) => {
          const message = body === undefined ? undefined : parse(body, row.id);
          if (message && this.#holdsMessage("", message)) {
            copies.add(row.id);
            lastLifted = Math.max(lastLifted, row.index);
          }
        }
      );
    }
    // The chat moved on after an earlier, partial lift when the session's
    // newest message is not the last lifted row. A row imported now would
    // become the newest and hide that history, so none is: the rest stay
    // in the table, recoverable.
    const leafId = this.#tail("").leafId;
    const movedOn =
      leafId !== null && (lastLifted < 0 || order[lastLifted].id !== leafId);

    let parentId: string | null = null;
    let imported = 0;
    let skipped = 0;
    this.#forEachLegacyRow(table, order, (row, body) => {
      if (copies.has(row.id)) {
        // Verified above: count it without decoding it again.
        parentId = row.id;
        imported++;
        return;
      }
      if (!present.has(row.id) && (movedOn || row.index < lastLifted)) {
        skipped++;
        return;
      }
      const message = body === undefined ? undefined : parse(body, row.id);
      if (!message) {
        skipped++;
        return;
      }
      try {
        const parsedTime =
          typeof row.created_at === "number"
            ? row.created_at
            : Date.parse(String(row.created_at ?? ""));
        const inserted = this.importMessage("", message, {
          parentId,
          createdAt: Number.isFinite(parsedTime) ? parsedTime : imported
        });
        parentId = message.id;
        // An id already taken counts as copied only when it holds this
        // payload: dropping the table must not lose a row whose id some
        // other message occupies.
        if (!inserted && !this.#holdsMessage("", message)) {
          skipped++;
          return;
        }
        imported++;
      } catch (error) {
        console.error(`[Sessions] Failed to lift message ${row.id}:`, error);
        skipped++;
      }
    });

    if (skipped === 0 && imported === order.length) {
      this.io.sqlWrite(`DROP TABLE ${table}`, []);
      return true;
    }
    console.error(
      `[Sessions] Legacy lift imported ${imported} of ${order.length} rows ` +
        `(${skipped} skipped); leaving ${table} in place so they remain ` +
        "recoverable."
    );
    this.io.emit("session:migration:incomplete", {
      table,
      source: order.length,
      copied: imported
    });
    return false;
  }

  /**
   * Visit `rows`, in order, with their bodies, fetched in windows bounded
   * by row count and summed bytes, so one query binds one window of ids.
   */
  #forEachLegacyRow<Row extends { id: string; bytes: number }>(
    table: string,
    rows: readonly Row[],
    visit: (row: Row, body: string | undefined) => void
  ): void {
    let next = 0;
    while (next < rows.length) {
      const window: Row[] = [];
      let bytes = 0;
      while (
        next < rows.length &&
        window.length < LEGACY_LIFT_WINDOW_ROWS &&
        (window.length === 0 ||
          bytes + rows[next].bytes <= LEGACY_LIFT_WINDOW_BYTES)
      ) {
        bytes += rows[next].bytes;
        window.push(rows[next]);
        next++;
      }
      const bodies = new Map(
        this.io
          .sql<{ id: string; message: string }>(
            `SELECT id, message FROM ${table}
             WHERE id IN (SELECT value FROM json_each(?))`,
            [JSON.stringify(window.map((row) => row.id))]
          )
          .map((row) => [row.id, row.message] as const)
      );
      for (const row of window) visit(row, bodies.get(row.id));
    }
  }

  /** Whether the stored row with `message.id` holds exactly `message`. */
  #holdsMessage(sessionId: string, message: SessionMessage): boolean {
    const json = JSON.stringify(extractAttachments(message).message);
    const [row] = this.io.sql<{ content_hash: string | null }>(
      `SELECT content_hash FROM ${this.#t.messages} WHERE session_id = ? AND id = ?`,
      [sessionId, message.id]
    );
    if (!row) return false;
    if (row.content_hash != null)
      return row.content_hash === contentDigest(json);
    return this.#content(sessionId, message.id) === json;
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
      `SELECT id, content FROM ${this.#t.chunks}
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
      `SELECT content, content_chunks FROM ${this.#t.messages} WHERE session_id = ? AND id = ?`,
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
        `SELECT id FROM ${this.#t.messages} WHERE session_id = ? AND id = ?`,
        [sessionId, id]
      ).length > 0
    );
  }

  /** Which of `ids` are stored in the session: key probes, ids only. */
  existingIds(sessionId: string, ids: readonly string[]): Set<string> {
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += DELETE_BATCH_IDS) {
      for (const row of this.io.sql<{ id: string }>(
        `SELECT id FROM ${this.#t.messages}
         WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
        [sessionId, JSON.stringify(ids.slice(i, i + DELETE_BATCH_IDS))]
      )) {
        found.add(row.id);
      }
    }
    // A summary the visible transcript shows (`compaction_<id>`) has no
    // stored row: it exists while its overlay does.
    const summaries = ids
      .filter((id) => id.startsWith(COMPACTION_PREFIX))
      .map((id) => id.slice(COMPACTION_PREFIX.length));
    if (summaries.length > 0) {
      for (const row of this.io.sql<{ id: string }>(
        `SELECT id FROM ${this.#t.compactions}
         WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
        [sessionId, JSON.stringify(summaries)]
      )) {
        found.add(`${COMPACTION_PREFIX}${row.id}`);
      }
    }
    return found;
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
    let tail: Tail;
    if (this.#hasTailIndex()) {
      const [row] = this.io.sql<{ id: string; seq: number }>(
        `SELECT id, seq FROM ${this.#t.messages} WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
        [sessionId]
      );
      tail = row
        ? { leafId: row.id, nextSeq: row.seq + 1, rows: null }
        : { leafId: null, nextSeq: 1, rows: null };
    } else {
      const [row] = this.io.sql<{ id: string; seq: number }>(
        `SELECT id, seq FROM ${this.#t.messages} WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
        [sessionId]
      );
      tail = row
        ? {
            leafId: row.id,
            nextSeq: row.seq + 1,
            rows: this.#rowsOrIndex(sessionId, row.seq)
          }
        : { leafId: null, nextSeq: 1, rows: 0 };
    }
    this.#tails.set(sessionId, tail);
    return tail;
  }

  /**
   * The tail after appending `leafId` as row `tail.nextSeq`. The tail moves
   * first: the row is stored, so the next append must number from it even
   * if building the index then fails.
   */
  #appended(sessionId: string, tail: Tail, leafId: string): void {
    const next: Tail = {
      leafId,
      nextSeq: tail.nextSeq + 1,
      rows: tail.rows === null ? null : tail.rows + 1
    };
    this.#tails.set(sessionId, next);
    if (next.rows !== null) {
      next.rows = this.#rowsOrIndex(sessionId, next.rows);
    }
  }

  /**
   * Given an upper bound on a session's stored rows, return a bound to keep,
   * or `null` once there is nothing left to count for (the index exists, or
   * building it failed in this isolate). Below `TAIL_INDEX_ROWS` the bound
   * is enough; at it, the rows are counted (a retention-trimmed chat has a
   * high `seq` and few rows), and the index is created if they are there.
   */
  #rowsOrIndex(sessionId: string, atMost: number): number | null {
    if (atMost < TAIL_INDEX_ROWS) return atMost;
    // The index couldn't be built in this isolate: stop counting.
    if (this.#tailIndexFailed) return null;
    const [{ rows }] = this.io.sql<{ rows: number }>(
      `SELECT count(*) AS rows FROM ${this.#t.messages} WHERE session_id = ?`,
      [sessionId]
    );
    if (rows < TAIL_INDEX_ROWS) return rows;
    this.#ensureTailIndex(sessionId);
    return null;
  }

  /** Whether the tail index exists; a positive answer is remembered. */
  #hasTailIndex(): boolean {
    if (!this.#tailIndexed) {
      this.#tailIndexed =
        this.io.sql<{ one: number }>(
          `SELECT 1 AS one FROM sqlite_master WHERE type = 'index' AND name = '${this.#t.tailIndex}'`,
          []
        ).length > 0;
    }
    return this.#tailIndexed;
  }

  /**
   * Index the message table by `(session_id, seq)`, so finding a session's
   * newest row reads one row instead of scanning the session. Created the
   * first time a session holds `TAIL_INDEX_ROWS` stored rows (counted, not
   * its newest `seq`, which retention leaves high); the only place the
   * index is made. It covers every session in the object from then on.
   */
  #ensureTailIndex(sessionId: string): boolean {
    if (this.#tailIndexed) return true;
    if (this.#tailIndexFailed) return false;
    try {
      this.io.sqlWrite(
        `CREATE INDEX IF NOT EXISTS ${this.#t.tailIndex}
         ON ${this.#t.messages} (session_id, seq)`,
        []
      );
    } catch (error) {
      // The index only speeds the lookup up. One that can't be built (the
      // database is near its size limit) leaves the scan in place, and
      // this isolate doesn't try again.
      this.#tailIndexFailed = true;
      this.io.emit("session:error", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
    this.#tailIndexed = true;
    return true;
  }

  /**
   * Drop the in-memory tail and token-total caches for a session. For a
   * caller whose enclosing transaction rolled back after an append or update
   * ran inside it: the rows are gone but the caches already moved. The next
   * read re-derives both from storage.
   */
  forgetCaches(sessionId: string): void {
    this.#tails.delete(sessionId);
    // A rolled-back transaction may have taken a just-built index with it.
    this.#tailIndexed = false;
    this.#pathTokens.delete(sessionId);
  }

  latestLeafId(sessionId: string): string | null {
    return this.#tail(sessionId).leafId;
  }

  #resolveLeafId(sessionId: string, leafId?: string | null): string | null {
    if (leafId) return this.exists(sessionId, leafId) ? leafId : null;
    return this.latestLeafId(sessionId);
  }

  /**
   * Which of `ids` are hidden overlay rows. Reads the session's compaction
   * records only when some id carries the prefix.
   */
  #hiddenOverlayIds(sessionId: string, ids: readonly string[]): Set<string> {
    if (!ids.some(hasOverlayPrefix)) return new Set();
    const overlays = new Set(
      this.getCompactions(sessionId).map(
        (compaction) => `${COMPACTION_PREFIX}${compaction.id}`
      )
    );
    return new Set(ids.filter((id) => overlays.has(id)));
  }

  getLatestLeaf(sessionId: string): SessionMessage | null {
    let leafId = this.latestLeafId(sessionId);
    while (
      leafId !== null &&
      this.#hiddenOverlayIds(sessionId, [leafId]).has(leafId)
    ) {
      const [row] = this.io.sql<{ parent_id: string | null }>(
        `SELECT parent_id FROM ${this.#t.messages} WHERE session_id = ? AND id = ?`,
        [sessionId, leafId]
      );
      leafId = row?.parent_id ?? null;
    }
    return leafId ? this.getMessage(sessionId, leafId) : null;
  }

  /** Children of a row in `seq` order, hidden overlay rows replaced by theirs. */
  #childRows(
    sessionId: string,
    parentId: string
  ): Array<{
    id: string;
    seq: number;
    content: string;
    content_chunks: number;
  }> {
    const rows = this.io.sql<{
      id: string;
      seq: number;
      content: string;
      content_chunks: number;
    }>(
      `SELECT id, seq, content, content_chunks FROM ${this.#t.messages}
       WHERE session_id = ? AND parent_id = ? ORDER BY seq ASC`,
      [sessionId, parentId]
    );
    const hidden = this.#hiddenOverlayIds(
      sessionId,
      rows.map((row) => row.id)
    );
    if (hidden.size === 0) return rows;
    return rows
      .flatMap((row) =>
        hidden.has(row.id) ? this.#childRows(sessionId, row.id) : [row]
      )
      .sort((a, b) => a.seq - b.seq);
  }

  getBranches(sessionId: string, messageId: string): SessionMessage[] {
    const rows = this.#childRows(sessionId, messageId);
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

  // ── Reads ────────────────────────────────────────────────────────────────
  //
  // What the model sees is resolved from the leaf towards the root. At each
  // row the walk asks whether an overlay ends there (the newest one whose
  // `resume_id` is known). If one does, it yields the overlay's summary and
  // continues at `resume_id`, the row below the overlay. Otherwise it yields
  // the row and continues at its parent. Nothing below an overlay is read,
  // so a read costs the visible path, not the stored history, and no depth
  // bound is needed: `seq` falls at every step, including the jump.

  /**
   * One batch of the visible walk: at most `maxSteps` steps from `startId`
   * towards the root, leaf-back. Ids, roles and stamped estimates only;
   * content never rides the recursion (#1710). With `measure`, each step
   * also carries its hydrated size: the row, its continuation rows and the
   * payloads it points at (inlined size), or an overlay's summary.
   */
  #walk(
    sessionId: string,
    startId: string,
    maxSteps: number,
    measure: boolean
  ): VisibleStep[] {
    const overlayJoin = (row: string) => `LEFT JOIN ${this.#t.compactions} o
        ON o.session_id = ?1 AND o.to_message_id = ${row}.id
          AND o.resume_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${this.#t.compactions} n
            WHERE n.session_id = o.session_id
              AND n.to_message_id = o.to_message_id
              AND n.resume_id IS NOT NULL AND n.seq > o.seq)`;
    const next = `CASE WHEN o.seq IS NULL THEN m.parent_id
        ELSE NULLIF(o.resume_id, '') END`;
    // The row's stored length and chunk count ride the recursion as numbers;
    // content never does (#1710). With them the final select needs no second
    // lookup of the message row.
    const measured = measure
      ? `, CASE WHEN walk.overlay_seq IS NOT NULL THEN (
            SELECT LENGTH(CAST(c.summary AS BLOB))
            FROM ${this.#t.compactions} c
            WHERE c.session_id = ?1
              AND c.to_message_id = walk.id AND c.seq = walk.overlay_seq)
          ELSE walk.length + CASE WHEN walk.chunks = 0 THEN 0
            ELSE COALESCE((
              SELECT SUM(LENGTH(CAST(k.content AS BLOB)))
              FROM ${this.#t.chunks} k
              WHERE k.session_id = ?1 AND k.id = walk.id
            ), 0) END
          + COALESCE((
              SELECT SUM((meta.bytes + 2) / 3 * 4)
              FROM ${this.#t.attachmentRefs} r
              JOIN ${this.#t.attachmentMeta} meta ON meta.hash = r.hash
              WHERE r.session_id = ?1 AND r.message_id = walk.id
            ), 0) END AS bytes`
      : "";
    const row = (m: string) =>
      measure
        ? `LENGTH(CAST(${m}.content AS BLOB)), ${m}.content_chunks`
        : "0, 0";
    // A recursive CTE yields its rows in the order it generates them, which
    // is the walk's order: no sort.
    const steps = this.io.sql<VisibleStep>(
      `WITH RECURSIVE walk(id, role, token_estimate, overlay_seq, overlay_id, next, length, chunks, step) AS (
        SELECT m.id, m.role, m.token_estimate, o.seq, o.id, ${next}, ${row("m")}, 0
        FROM ${this.#t.messages} m
        ${overlayJoin("m")}
        WHERE m.session_id = ?1 AND m.id = ?2
        UNION ALL
        SELECT m.id, m.role, m.token_estimate, o.seq, o.id, ${next}, ${row("m")}, walk.step + 1
        FROM walk
        CROSS JOIN ${this.#t.messages} m
          ON m.session_id = ?1 AND m.id = walk.next
        ${overlayJoin("m")}
        WHERE walk.step + 1 < ?3
      )
      SELECT walk.id AS id, walk.role AS role,
        walk.token_estimate AS tokenEstimate,
        walk.overlay_seq AS overlaySeq, walk.overlay_id AS overlayId,
        walk.next AS next
        ${measured}
      FROM walk`,
      [sessionId, startId, maxSteps]
    );
    // Legacy stored overlay rows are rare and prefixed: checked here, so the
    // walk never probes the overlay table by id for an ordinary row.
    const hidden = this.#hiddenOverlayIds(
      sessionId,
      steps.filter((step) => step.overlaySeq === null).map((step) => step.id)
    );
    for (const step of steps) step.hidden = hidden.has(step.id);
    return steps;
  }

  /**
   * The visible walk from `leafId` (default: the latest leaf) in batches,
   * leaf-back. The first batch holds `firstBatch` steps and later ones grow
   * to `WALK_BATCH_STEPS`, so a reader that stops early pays for little
   * more than it took. The walk ends at the root.
   */
  *#walkBatches(
    sessionId: string,
    leafId: string | null | undefined,
    measure: boolean,
    firstBatch = WALK_BATCH_STEPS
  ): Generator<VisibleStep[], void, undefined> {
    let next = this.#resolveLeafId(sessionId, leafId);
    let size = firstBatch;
    while (next !== null) {
      const batch = this.#walk(sessionId, next, size, measure);
      if (batch.length === 0) return;
      yield batch;
      next = batch[batch.length - 1].next;
      size = Math.min(size * 4, WALK_BATCH_STEPS);
    }
  }

  /**
   * Every visible step from the leaf, root → leaf, for readers that must
   * start at the root. They hold one step per visible message before any
   * content is read, so the list is bounded: past `MAX_ROOT_FIRST_STEPS`
   * the read throws, and never returns a shorter path.
   */
  #visiblePath(
    sessionId: string,
    leafId: string | null | undefined,
    measure: boolean
  ): VisibleStep[] {
    const steps: VisibleStep[] = [];
    for (const batch of this.#walkBatches(sessionId, leafId, measure)) {
      for (const step of batch) if (!step.hidden) steps.push(step);
      if (steps.length > MAX_ROOT_FIRST_STEPS) {
        throw pathTooLong(leafId);
      }
    }
    return steps.reverse();
  }

  /** The stored overlay a walk step applied. */
  #overlayAt(
    sessionId: string,
    step: { id: string; overlaySeq: number | null }
  ): StoredCompaction {
    const [row] = this.io.sql<CompactionRow>(
      `SELECT id, summary, from_message_id, to_message_id, created_at
       FROM ${this.#t.compactions}
       WHERE session_id = ? AND to_message_id = ? AND seq = ?`,
      [sessionId, step.id, step.overlaySeq]
    );
    return toStoredCompaction(row);
  }

  /**
   * The raw stored path, root → leaf, as content-free rows: every row on
   * it, rows under an overlay included, legacy hidden overlay rows left
   * out. For callers that count stored rows (retention, fork). Root-first,
   * so it is bounded like `#visiblePath`.
   */
  pathRowStats(sessionId: string, leafId?: string | null): SessionRowStat[] {
    const leaf = this.#resolveLeafId(sessionId, leafId);
    if (!leaf) return [];
    const walked = this.io.sql<SessionRowStat>(
      `WITH RECURSIVE path(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM ${this.#t.messages}
        WHERE session_id = ? AND id = ?
        UNION ALL
        SELECT m.id, m.parent_id, p.depth + 1 FROM path p
        CROSS JOIN ${this.#t.messages} m
          ON m.session_id = ? AND m.id = p.parent_id
        WHERE p.depth < ${MAX_ROOT_FIRST_STEPS}
      )
      SELECT path.id AS id, am.role AS role, ${rowBytesSql(this.#t)} AS bytes,
        am.token_estimate AS tokenEstimate
      FROM path CROSS JOIN ${this.#t.messages} am
        ON am.session_id = ? AND am.id = path.id
      ORDER BY path.depth DESC`,
      [sessionId, leaf, sessionId, sessionId]
    );
    if (walked.length > MAX_ROOT_FIRST_STEPS) {
      throw pathTooLong(leafId);
    }
    const hidden = this.#hiddenOverlayIds(
      sessionId,
      walked.map((row) => row.id)
    );
    return hidden.size === 0
      ? walked
      : walked.filter((row) => !hidden.has(row.id));
  }

  /**
   * A page of the stored path from the leaf back: the rows at depth `skip`
   * to `skip + limit - 1` (the leaf is depth 0), or counted from the parent
   * of `after`, rows under an overlay included, legacy hidden overlay rows
   * left out. With `measure`, each
   * carries its hydrated size. Holds one page, so a caller can work through
   * a path of any length (retention, media eviction).
   */
  storedPathRows(
    sessionId: string,
    options: { skip: number; limit: number; measure?: boolean; after?: string }
  ): Array<{ id: string; bytes: number }> {
    // `after` continues from a row a previous page returned: the walk starts
    // at its parent, so paging never re-walks from the leaf.
    const leaf =
      options.after === undefined
        ? this.latestLeafId(sessionId)
        : (this.io.sql<{ parent_id: string | null }>(
            `SELECT parent_id FROM ${this.#t.messages} WHERE session_id = ? AND id = ?`,
            [sessionId, options.after]
          )[0]?.parent_id ?? null);
    if (!leaf || options.limit <= 0) return [];
    // Depths count visible rows: a legacy hidden overlay row is walked
    // through but neither counted nor returned, so it cannot shorten a
    // caller's protected tail. Hidden rows are rare; when some fall in the
    // range, the walk widens by that many and repeats.
    const wanted = options.skip + options.limit;
    let reach = wanted;
    let page: string[];
    for (;;) {
      const walked = this.io
        .sql<{ id: string }>(
          `WITH RECURSIVE path(id, parent_id, depth) AS (
            SELECT id, parent_id, 0 FROM ${this.#t.messages}
            WHERE session_id = ? AND id = ?
            UNION ALL
            SELECT m.id, m.parent_id, p.depth + 1 FROM path p
            CROSS JOIN ${this.#t.messages} m
              ON m.session_id = ? AND m.id = p.parent_id
            WHERE p.depth + 1 < ?
          )
          SELECT id FROM path`,
          [sessionId, leaf, sessionId, reach]
        )
        .map((row) => row.id);
      const hidden = this.#hiddenOverlayIds(sessionId, walked);
      const visible =
        hidden.size === 0 ? walked : walked.filter((id) => !hidden.has(id));
      if (visible.length >= wanted || walked.length < reach) {
        page = visible.slice(options.skip, wanted);
        break;
      }
      reach += wanted - visible.length;
    }
    if (!options.measure || page.length === 0) {
      return page.map((id) => ({ id, bytes: 0 }));
    }
    const bytes = new Map(
      this.io
        .sql<{ id: string; bytes: number }>(
          `SELECT am.id AS id, ${rowBytesSql(this.#t)} AS bytes
           FROM ${this.#t.messages} am
           WHERE am.session_id = ? AND am.id IN (SELECT value FROM json_each(?))`,
          [sessionId, JSON.stringify(page)]
        )
        .map((row) => [row.id, row.bytes] as const)
    );
    return page.map((id) => ({ id, bytes: bytes.get(id) ?? 0 }));
  }

  /**
   * Split path rows into bounded hydration queries: at most `maxRows` rows,
   * and — when the rows carry sizes — at most `HISTORY_CONTENT_CHUNK_BYTES`
   * of stored content, with a single oversized row always standing alone.
   */
  *#boundedStatsChunks(
    rows: readonly PathRow[],
    maxRows = HISTORY_CONTENT_CHUNK_SIZE
  ): Generator<readonly PathRow[], void, undefined> {
    let start = 0;
    while (start < rows.length) {
      let end = start;
      let bytes = 0;
      while (end < rows.length && end - start < maxRows) {
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
    rows: readonly PathRow[]
  ): Map<string, SessionMessage> {
    const result = new Map<string, SessionMessage>();
    if (rows.length === 0) return result;
    const fetched = this.io.sql<{
      id: string;
      content: string;
      content_chunks: number;
    }>(
      `SELECT id, content, content_chunks FROM ${this.#t.messages}
       WHERE session_id = ? AND id IN (${rows.map(() => "?").join(", ")})`,
      [sessionId, ...rows.map((row) => row.id)]
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

  /**
   * Stream walk steps in the order given: an overlay step as its summary
   * message, runs of rows in bounded content windows (`windowRows` rows,
   * and `HISTORY_CONTENT_CHUNK_BYTES` when the steps carry sizes). Peak
   * memory is one window.
   */
  async *#streamSteps(
    sessionId: string,
    steps: readonly VisibleStep[],
    windowRows: number,
    signal?: AbortSignal
  ): AsyncGenerator<SessionMessage, void, undefined> {
    let index = 0;
    while (index < steps.length) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("History read aborted");
      }
      const step = steps[index];
      if (step.hidden) {
        index++;
        continue;
      }
      if (step.overlaySeq !== null) {
        yield overlayMessage(this.#overlayAt(sessionId, step));
        index++;
        continue;
      }
      let runEnd = index + 1;
      while (runEnd < steps.length && steps[runEnd].overlaySeq === null) {
        runEnd++;
      }
      const rows = steps
        .slice(index, runEnd)
        .filter((row) => !row.hidden)
        .map((row) => ({ id: row.id, bytes: row.bytes ?? 0 }));
      for (const chunk of this.#boundedStatsChunks(rows, windowRows)) {
        const content = this.#contentByStats(sessionId, chunk);
        for (const row of chunk) {
          const parsed = content.get(row.id);
          if (parsed) yield parsed;
        }
        if (signal?.aborted) {
          throw signal.reason ?? new Error("History read aborted");
        }
      }
      index = runEnd;
    }
  }

  /**
   * Stream the visible path ending at `leafId` (default: active leaf),
   * root → leaf, or leaf → root with `newestFirst`. Newest-first is the walk
   * itself: a consumer that stops early has read only the steps it took.
   */
  async *streamHistory(
    sessionId: string,
    options: HistoryReadOptions
  ): AsyncGenerator<SessionMessage, void, undefined> {
    if (options.newestFirst === true) {
      yield* this.#newestFirst(sessionId, options.leafId, options.signal);
      return;
    }
    const steps = this.#visiblePath(sessionId, options.leafId, true);
    yield* this.#streamSteps(
      sessionId,
      steps,
      HISTORY_CONTENT_CHUNK_SIZE,
      options.signal
    );
  }

  /**
   * The visible walk as point reads, newest first: one statement per step
   * reads the row with its content and probes for an overlay ending there.
   * Each message costs about one row read, and a consumer that stops early
   * (a tool-call owner lookup) has paid for exactly the steps it took.
   */
  async *#newestFirst(
    sessionId: string,
    leafId: string | null | undefined,
    signal?: AbortSignal
  ): AsyncGenerator<SessionMessage, void, undefined> {
    let next = this.#resolveLeafId(sessionId, leafId);
    while (next !== null) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("History read aborted");
      }
      const [row] = this.io.sql<{
        parent_id: string | null;
        content: string | null;
        content_chunks: number;
        overlay_seq: number | null;
        resume_id: string | null;
      }>(
        `SELECT m.parent_id, CASE WHEN o.seq IS NULL THEN m.content END AS content,
           m.content_chunks, o.seq AS overlay_seq, o.resume_id
         FROM ${this.#t.messages} m
         LEFT JOIN ${this.#t.compactions} o
           ON o.session_id = m.session_id AND o.to_message_id = m.id
             AND o.resume_id IS NOT NULL
         WHERE m.session_id = ? AND m.id = ?
         ORDER BY o.seq DESC LIMIT 1`,
        [sessionId, next]
      );
      if (!row) return;
      const id: string = next;
      if (row.overlay_seq !== null) {
        yield overlayMessage(
          this.#overlayAt(sessionId, { id, overlaySeq: row.overlay_seq })
        );
        next = row.resume_id || null;
        continue;
      }
      if (!this.#hiddenOverlayIds(sessionId, [id]).has(id)) {
        const json =
          row.content_chunks === 0
            ? (row.content ?? "")
            : (row.content ?? "") +
              (this.#continuations(sessionId, [id]).get(id) ?? "");
        const parsed = this.#parse(json);
        if (parsed) yield this.#inline(parsed);
      }
      next = row.parent_id;
    }
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
   * The oldest part of the visible path that fits `maxBytes`, root first:
   * what `compact()` hands the compaction function. A path that fits is
   * returned whole. A longer one compacts in rounds: each round summarises
   * its oldest part, the overlay ends inside it, and the next round starts
   * from the summary. The walk goes from the leaf, measured, keeping only
   * the steps seen last (the oldest) within the budget, so it holds at most
   * `maxBytes` of steps and needs no id list of the whole path. Each message
   * is charged `RECENT_MESSAGE_OVERHEAD_BYTES` on top of its stored bytes,
   * as in `getRecentHistory`. At least one message is returned, so a single
   * oldest message larger than `maxBytes` is returned alone. `omitted` is how
   * many newer visible messages were left out, `omittedTokens` their
   * estimated tokens.
   */
  async oldestVisible(
    sessionId: string,
    maxBytes: number,
    leafId?: string | null
  ): Promise<{
    messages: SessionMessage[];
    omitted: number;
    omittedTokens: number;
  }> {
    // Newest at the front, oldest at the back; dropped from the front.
    const kept: VisibleStep[] = [];
    let start = 0;
    let used = 0;
    // Newer visible messages left out, counted apart from `start`, which
    // goes back to 0 whenever the dropped prefix is trimmed off.
    let omitted = 0;
    let omittedTokens = 0;
    for (const batch of this.#walkBatches(sessionId, leafId, true)) {
      for (const step of batch) {
        if (step.hidden) continue;
        kept.push(step);
        used += (step.bytes ?? 0) + RECENT_MESSAGE_OVERHEAD_BYTES;
        while (used > maxBytes && kept.length - start > 1) {
          const dropped = kept[start++];
          omitted++;
          // An overlay is seen as its summary, so it counts as that.
          omittedTokens +=
            dropped.overlaySeq === null
              ? dropped.tokenEstimate
              : estimateStringTokens(
                  this.#overlayAt(sessionId, dropped).summary
                );
          used -= (dropped.bytes ?? 0) + RECENT_MESSAGE_OVERHEAD_BYTES;
        }
      }
      // Compact the array once the dropped prefix dominates it.
      if (start > 1024 && start > kept.length / 2) {
        kept.splice(0, start);
        start = 0;
      }
    }
    const messages: SessionMessage[] = [];
    for await (const message of this.#streamSteps(
      sessionId,
      kept.slice(start).reverse(),
      HISTORY_CONTENT_CHUNK_SIZE
    )) {
      messages.push(message);
    }
    return { messages, omitted, omittedTokens };
  }

  /**
   * Byte-budgeted read of the most recent visible messages: the walk from
   * the leaf, until the next message would pass `maxContentBytes`. An
   * overlay counts as its summary, and every message is charged
   * `RECENT_MESSAGE_OVERHEAD_BYTES` on top of its stored bytes. The newest message is always returned,
   * even alone over the budget, since returning nothing is worse. There is
   * no message-count floor: one used to admit rows regardless of size.
   * `totalContentBytes` is the size of the visible path. Once the budget
   * stops the read, the walk finishes the batch it is in and stops, so on a
   * long path the total is the measured part (already past the budget),
   * not a walk to the root.
   */
  async getRecentHistory(
    sessionId: string,
    maxContentBytes: number,
    leafId?: string | null
  ): Promise<RecentHistoryResult> {
    const window: VisibleStep[] = [];
    let used = 0;
    let truncated = false;
    let totalContentBytes = 0;
    for (const batch of this.#walkBatches(
      sessionId,
      leafId,
      true,
      RECENT_FIRST_BATCH_STEPS
    )) {
      for (const step of batch) {
        if (step.hidden) continue;
        const bytes = step.bytes ?? 0;
        totalContentBytes += bytes;
        if (truncated) continue;
        const cost = bytes + RECENT_MESSAGE_OVERHEAD_BYTES;
        if (window.length > 0 && used + cost > maxContentBytes) {
          truncated = true;
          continue;
        }
        window.push(step);
        used += cost;
      }
      if (truncated) break;
    }
    const messages: SessionMessage[] = [];
    for await (const message of this.#streamSteps(
      sessionId,
      window.reverse(),
      HISTORY_CONTENT_CHUNK_SIZE
    )) {
      messages.push(message);
    }
    return { messages, truncated, totalContentBytes };
  }

  /**
   * Heuristic token estimate for what the model sees: stamped per-row
   * estimates along the visible walk, an overlay counted as its summary.
   * Ids and stamped numbers only; it gates cheap triggers, and
   * model-reported usage stays authoritative.
   */
  tokenEstimate(sessionId: string): number {
    const leafId = this.latestLeafId(sessionId);
    const memo = this.#pathTokens.get(sessionId);
    if (memo && memo.leafId === leafId) {
      return Math.max(0, Math.ceil(memo.total));
    }
    let tokens = 0;
    for (const batch of this.#walkBatches(sessionId, leafId, false)) {
      for (const step of batch) {
        if (step.hidden) continue;
        tokens +=
          step.overlaySeq === null
            ? step.tokenEstimate
            : estimateStringTokens(this.#overlayAt(sessionId, step).summary);
      }
    }
    this.#pathTokens.set(sessionId, { leafId, total: tokens });
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
        `INSERT OR REPLACE INTO ${this.#t.chunks}
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
    // A repeated append is answered from storage; the common path (a fresh
    // id) costs a key-only probe rather than a content read.
    if (this.exists(sessionId, message.id)) {
      const existing = this.getMessage(sessionId, message.id);
      if (existing) return { inserted: false, message: existing };
    }

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
    const {
      message: staged,
      attachments,
      references
    } = extractAttachments(message);
    const json = JSON.stringify(staged);
    const slices = splitContent(json);
    const seq = tail.nextSeq;
    this.io.transaction(() => {
      for (const attachment of attachments) {
        this.#attachments.put(attachment.payload, attachment.hash);
      }
      this.io.sqlWrite(
        `INSERT INTO ${this.#t.messages}
          (session_id, id, seq, parent_id, role, content, content_chunks, token_estimate, created_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          message.id,
          seq,
          parent,
          message.role,
          slices[0],
          slices.length - 1,
          tokenEstimate,
          Date.now(),
          contentDigest(json)
        ]
      );
      this.#writeContinuations(sessionId, message.id, slices);
      this.#attachments.addRefs(sessionId, message.id, references);
      this.#indexFts(sessionId, staged, false);
    });

    // The freshly inserted row is the most recent childless node, so it is
    // now the latest leaf — true even for an explicit-parent branch append.
    this.#appended(sessionId, tail, message.id);
    const memo = this.#pathTokens.get(sessionId);
    if (memo) {
      if (memo.leafId === parent) {
        // The row extends the memoised path: count it, no re-walk.
        memo.leafId = message.id;
        memo.total += tokenEstimate;
      } else {
        // A branch: a different path. Re-derive on the next read.
        this.#pathTokens.delete(sessionId);
      }
    }
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
   * FULL content, through the digest the last write stamped, so neither the
   * payload nor a continuation row is read. A row without a digest compares
   * the reassembled content once and is stamped.
   */
  update(
    sessionId: string,
    message: SessionMessage,
    tokenEstimate: number
  ): UpdateOutcome {
    // Key-side columns only; the payload stays in SQLite.
    const oldRows = this.io.sql<{
      content_chunks: number;
      token_estimate: number;
      content_hash: string | null;
    }>(
      `SELECT content_chunks, token_estimate, content_hash FROM ${this.#t.messages} WHERE session_id = ? AND id = ?`,
      [sessionId, message.id]
    );
    if (oldRows.length === 0) return "missing";
    const old = oldRows[0];
    // Compare in stored form: a re-sent identical image extracts to the same
    // address, so an unchanged update still writes nothing.
    const {
      message: staged,
      attachments,
      references
    } = extractAttachments(message);
    const json = JSON.stringify(staged);
    const digest = contentDigest(json);
    if (old.content_hash !== null) {
      if (old.content_hash === digest) return "unchanged";
    } else if (this.#content(sessionId, message.id) === json) {
      // Byte-identical: stamp the digest so this row stops paying the
      // read-back. Still `unchanged`: no continuation, FTS, or event.
      this.io.sqlWrite(
        `UPDATE ${this.#t.messages} SET content_hash = ? WHERE session_id = ? AND id = ?`,
        [digest, sessionId, message.id]
      );
      return "unchanged";
    }

    const slices = splitContent(json);
    this.io.transaction(() => {
      for (const attachment of attachments) {
        this.#attachments.put(attachment.payload, attachment.hash);
      }
      this.io.sqlWrite(
        `UPDATE ${this.#t.messages}
         SET role = ?, content = ?, content_chunks = ?, token_estimate = ?, content_hash = ?
         WHERE session_id = ? AND id = ?`,
        [
          message.role,
          slices[0],
          slices.length - 1,
          tokenEstimate,
          digest,
          sessionId,
          message.id
        ]
      );
      // A message that shrank leaves surplus continuations behind; they go
      // in the same transaction as the row that stopped referencing them.
      if (old.content_chunks > slices.length - 1) {
        this.io.sqlWrite(
          `DELETE FROM ${this.#t.chunks}
           WHERE session_id = ? AND id = ? AND idx > ?`,
          [sessionId, message.id, slices.length - 1]
        );
      }
      this.#writeContinuations(sessionId, message.id, slices);
      // Payloads are stored before references move, so a hash this message
      // still uses is never momentarily unreferenced and collected.
      this.#attachments.replaceRefs(sessionId, message.id, references);
      this.#indexFts(sessionId, staged, true);
    });
    const memo = this.#pathTokens.get(sessionId);
    if (memo?.leafId === message.id) {
      memo.total += tokenEstimate - (old.token_estimate ?? 0);
    } else if (memo) {
      // Whether an older row is visible is not known without a walk.
      this.#pathTokens.delete(sessionId);
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
  deleteMessages(sessionId: string, messageIds: string[]): void {
    const uniqueIds = [...new Set(messageIds)];
    if (uniqueIds.length === 0) return;

    this.io.transaction(() => {
      // One bound JSON value holds a limited number of ids, so the delete
      // runs in batches. Batches compose: after one, its rows are gone and
      // their children already point past them.
      for (let i = 0; i < uniqueIds.length; i += DELETE_BATCH_IDS) {
        this.#deleteBatch(sessionId, uniqueIds.slice(i, i + DELETE_BATCH_IDS));
      }
    });
    // The leaf may be among the deleted rows; re-derive on the next append.
    this.#tails.delete(sessionId);
    this.#pathTokens.delete(sessionId);
    this.io.emit("session:messages:deleted", {
      sessionId,
      count: uniqueIds.length
    });
  }

  #deleteBatch(sessionId: string, batch: readonly string[]): void {
    const ids = JSON.stringify(batch);
    const orphanedCopies = this.#overlaysFollowSplice(sessionId, batch);
    // Each surviving child of a deleted row moves to its nearest surviving
    // ancestor. The pairs are read once (finding the children scans the
    // session's rows once: there is no `parent_id` index, which would cost a
    // row on every append), then the children are updated by key.
    const rewired = this.io.sql<{
      child_id: string;
      ancestor_id: string | null;
    }>(
      `WITH RECURSIVE
       children(child_id, ancestor_id) AS MATERIALIZED (
         SELECT id, parent_id FROM ${this.#t.messages}
         WHERE session_id = ?2
           AND parent_id IN (SELECT value FROM json_each(?1))
           AND id NOT IN (SELECT value FROM json_each(?1))
       ),
       rewire(child_id, ancestor_id) AS (
         SELECT child_id, ancestor_id FROM children
         UNION ALL
         SELECT rewire.child_id, parent.parent_id
         FROM rewire
         JOIN ${this.#t.messages} AS parent
           ON parent.session_id = ?2 AND parent.id = rewire.ancestor_id
         WHERE rewire.ancestor_id IN (SELECT value FROM json_each(?1))
       )
       SELECT child_id, ancestor_id FROM rewire
       WHERE ancestor_id IS NULL
          OR ancestor_id NOT IN (SELECT value FROM json_each(?1))`,
      [ids, sessionId]
    );
    // One keyed update per new parent: a deleted run has one child.
    const byAncestor = new Map<string | null, string[]>();
    for (const row of rewired) {
      const children = byAncestor.get(row.ancestor_id);
      if (children) children.push(row.child_id);
      else byAncestor.set(row.ancestor_id, [row.child_id]);
    }
    for (const [ancestor, children] of byAncestor) {
      this.io.sqlWrite(
        `UPDATE ${this.#t.messages} SET parent_id = ?
         WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
        [ancestor, sessionId, JSON.stringify(children)]
      );
    }
    this.io.sqlWrite(
      `DELETE FROM ${this.#t.messages}
       WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
      [sessionId, ids]
    );
    this.io.sqlWrite(
      `DELETE FROM ${this.#t.chunks}
       WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
      [sessionId, ids]
    );
    this.#attachments.releaseMessages(sessionId, batch);
    this.io.sqlWrite(
      `DELETE FROM ${this.#t.annotations}
       WHERE session_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
      [sessionId, ids]
    );
    if (this.#fts) {
      this.io.sqlWrite(
        `DELETE FROM ${this.#t.fts}
         WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
        [sessionId, ids]
      );
    }
    // A removed overlay no longer hides a stored copy of its summary (a
    // `compaction_<id>` row an earlier release wrote back, #1984): it goes
    // too, spliced like any deleted row.
    if (orphanedCopies.length > 0) this.#deleteBatch(sessionId, orphanedCopies);
  }

  /**
   * Keep overlays applying across a splice, before the rows go. An overlay
   * whose end row is deleted ends at that row's nearest surviving ancestor;
   * one whose continuation row is deleted continues at that row's nearest
   * surviving ancestor. An overlay left with nothing between its
   * continuation and its end covers no row and is deleted, with its
   * annotations.
   */
  #overlaysFollowSplice(sessionId: string, batch: readonly string[]): string[] {
    const ids = JSON.stringify(batch);
    const affected = this.io.sql<{
      seq: number;
      id: string;
      to_message_id: string;
      resume_id: string;
    }>(
      `SELECT seq, id, to_message_id, resume_id
       FROM ${this.#t.compactions}
       WHERE session_id = ? AND resume_id IS NOT NULL
         AND (to_message_id IN (SELECT value FROM json_each(?))
           OR resume_id IN (SELECT value FROM json_each(?)))`,
      [sessionId, ids, ids]
    );
    if (affected.length === 0) return [];
    const gone = new Set(batch);
    const starts = [
      ...new Set(
        affected.flatMap((o) =>
          [o.to_message_id, o.resume_id].filter((id) => gone.has(id))
        )
      )
    ];
    const survivor = new Map(
      this.io
        .sql<{ start: string; ancestor: string | null }>(
          `WITH RECURSIVE
           deleted(id) AS (SELECT value FROM json_each(?)),
           up(start, cur) AS (
             SELECT value, value FROM json_each(?)
             UNION ALL
             SELECT up.start, m.parent_id FROM up
             CROSS JOIN ${this.#t.messages} m
               ON m.session_id = ? AND m.id = up.cur
             WHERE up.cur IN (SELECT id FROM deleted)
           )
           SELECT start, cur AS ancestor FROM up
           WHERE cur IS NULL OR cur NOT IN (SELECT id FROM deleted)`,
          [ids, JSON.stringify(starts), sessionId]
        )
        .map((row) => [row.start, row.ancestor] as const)
    );
    const moved = (id: string) =>
      gone.has(id) ? (survivor.get(id) ?? null) : id;
    const removed: string[] = [];
    for (const overlay of affected) {
      const resume =
        overlay.resume_id === "" ? "" : (moved(overlay.resume_id) ?? "");
      const to = moved(overlay.to_message_id);
      if (to === null || to === resume) {
        this.io.sqlWrite(
          `DELETE FROM ${this.#t.compactions}
           WHERE session_id = ? AND to_message_id = ? AND seq = ?`,
          [sessionId, overlay.to_message_id, overlay.seq]
        );
        removed.push(`${COMPACTION_PREFIX}${overlay.id}`);
        this.io.sqlWrite(
          `DELETE FROM ${this.#t.annotations}
           WHERE session_id = ? AND message_id = ?`,
          [sessionId, `${COMPACTION_PREFIX}${overlay.id}`]
        );
        continue;
      }
      this.io.sqlWrite(
        `UPDATE ${this.#t.compactions} SET to_message_id = ?, resume_id = ?
         WHERE session_id = ? AND to_message_id = ? AND seq = ?`,
        [to, resume, sessionId, overlay.to_message_id, overlay.seq]
      );
    }
    if (removed.length === 0) return [];
    return this.io
      .sql<{ id: string }>(
        `SELECT id FROM ${this.#t.messages}
         WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
        [sessionId, JSON.stringify(removed)]
      )
      .map((row) => row.id);
  }

  clearMessages(sessionId: string): void {
    this.io.transaction(() => {
      this.io.sqlWrite(`DELETE FROM ${this.#t.messages} WHERE session_id = ?`, [
        sessionId
      ]);
      this.io.sqlWrite(`DELETE FROM ${this.#t.chunks} WHERE session_id = ?`, [
        sessionId
      ]);
      this.io.sqlWrite(
        `DELETE FROM ${this.#t.compactions} WHERE session_id = ?`,
        [sessionId]
      );
      this.io.sqlWrite(
        `DELETE FROM ${this.#t.annotations} WHERE session_id = ?`,
        [sessionId]
      );
      // Keys under `transcript:` belong to the transcript; any other key
      // (an event-log epoch, say) outlives a clear.
      this.io.sqlWrite(
        `DELETE FROM ${this.#t.config}
         WHERE session_id = ? AND key >= '${TRANSCRIPT_CONFIG_PREFIX}'
           AND key < '${TRANSCRIPT_CONFIG_PREFIX_END}'`,
        [sessionId]
      );
      // When the transcript was last cleared, kept across clears: a module
      // that keeps something for turns from before a point (Context's
      // prompt frozen by an earlier release) reads it.
      this.setConfig(sessionId, CLEARED_AT_CONFIG_KEY, String(Date.now()));
      this.#attachments.releaseSession(sessionId);
      if (this.#fts) {
        this.io.sqlWrite(`DELETE FROM ${this.#t.fts} WHERE session_id = ?`, [
          sessionId
        ]);
      }
    });
    this.#tails.set(sessionId, {
      leafId: null,
      nextSeq: 1,
      rows: this.#tailIndexed ? null : 0
    });
    this.#pathTokens.delete(sessionId);
    this.io.emit("session:cleared", { sessionId });
  }

  // ── Compaction storage ───────────────────────────────────────────────────

  /**
   * Store an overlay replacing `from..to` on read. `from` must be `to` or an
   * ancestor of it; the walk continues below the overlay at `from`'s parent
   * (`resume_id`, `''` for the root). With `extendsId`, the new overlay
   * keeps that overlay's start and continuation (iterative compaction keeps
   * the head where the first compaction left it). Throws when the anchors
   * cannot apply, where an overlay that never applies used to be stored.
   */
  addCompaction(
    sessionId: string,
    summary: string,
    fromMessageId: string,
    toMessageId: string,
    extendsId?: string
  ): StoredCompaction {
    const id = crypto.randomUUID();
    const now = Date.now();
    // Validation and the annotations to carry are reads (the ancestry walk
    // can cover the whole span): they run before the write transaction, so
    // the transaction holds writes only. Nothing awaits in between.
    let from = fromMessageId;
    let resume: string;
    const extended = extendsId
      ? this.io.sql<{ from_message_id: string; resume_id: string | null }>(
          `SELECT from_message_id, resume_id FROM ${this.#t.compactions}
           WHERE session_id = ? AND id = ?`,
          [sessionId, extendsId]
        )[0]
      : undefined;
    if (extended && extended.resume_id !== null) {
      from = extended.from_message_id;
      resume = extended.resume_id;
      this.#assertOverlayEnd(sessionId, resume, toMessageId);
    } else {
      resume = this.#overlayResume(sessionId, from, toMessageId);
    }
    const carried = this.#annotationsToCarry(sessionId, resume, toMessageId);
    this.io.transaction(() => {
      const seq =
        this.io.sql<{ seq: number }>(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM ${this.#t.compactions} WHERE session_id = ?`,
          [sessionId]
        )[0]?.seq ?? 1;
      this.io.sqlWrite(
        `INSERT INTO ${this.#t.compactions}
          (session_id, to_message_id, seq, id, summary, from_message_id, resume_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, toMessageId, seq, id, summary, from, resume, now]
      );
      for (const { kind, value } of carried) {
        this.setAnnotation(sessionId, kind, `${COMPACTION_PREFIX}${id}`, value);
      }
    });
    // The new overlay changes which rows count; re-derive on the next read.
    this.#pathTokens.delete(sessionId);
    this.io.emit("session:compacted", { sessionId, compactionId: id });
    return {
      id,
      summary,
      fromMessageId: from,
      toMessageId,
      createdAt: new Date(now).toISOString()
    };
  }

  /**
   * Where the walk continues below an overlay `from..to`: `from`'s parent,
   * or `''` when `from` is a root. Throws unless both rows exist and `from`
   * is `to` or an ancestor of it (an id walk up from `to`, stopped once
   * `seq` falls below `from`'s).
   */
  #overlayResume(sessionId: string, from: string, to: string): string {
    const rows = this.io.sql<{
      id: string;
      seq: number;
      parent_id: string | null;
    }>(
      `SELECT id, seq, parent_id FROM ${this.#t.messages}
       WHERE session_id = ? AND id IN (?, ?)`,
      [sessionId, from, to]
    );
    const start = rows.find((row) => row.id === from);
    const end = rows.find((row) => row.id === to);
    if (!start || !end) {
      throw new Error(
        `Sessions: cannot store a compaction from "${from}" to "${to}": ` +
          `"${start ? to : from}" is not a message of this session.`
      );
    }
    if (from !== to && !this.#isAncestor(sessionId, start, to)) {
      throw new Error(
        `Sessions: cannot store a compaction from "${from}" to "${to}": ` +
          `"${from}" is not on the path to "${to}".`
      );
    }
    return start.parent_id ?? "";
  }

  /** Throw unless an extended overlay's continuation lies below `to`. */
  #assertOverlayEnd(sessionId: string, resume: string, to: string): void {
    const [end] = this.io.sql<{ seq: number }>(
      `SELECT seq FROM ${this.#t.messages} WHERE session_id = ? AND id = ?`,
      [sessionId, to]
    );
    if (!end) {
      throw new Error(
        `Sessions: cannot store a compaction to "${to}": it is not a message of this session.`
      );
    }
    if (resume === "") return;
    const [below] = this.io.sql<{ id: string; seq: number }>(
      `SELECT id, seq FROM ${this.#t.messages} WHERE session_id = ? AND id = ?`,
      [sessionId, resume]
    );
    if (!below || resume === to || !this.#isAncestor(sessionId, below, to)) {
      throw new Error(
        `Sessions: cannot extend a compaction to "${to}": it is not past the compacted range.`
      );
    }
  }

  /** Whether `ancestor` is on the path from `id` to the root (ids only). */
  #isAncestor(
    sessionId: string,
    ancestor: { id: string; seq: number },
    id: string
  ): boolean {
    return (
      this.io.sql<{ hit: number }>(
        `WITH RECURSIVE up(id, parent_id, seq) AS (
          SELECT id, parent_id, seq FROM ${this.#t.messages}
          WHERE session_id = ? AND id = ?
          UNION ALL
          SELECT m.id, m.parent_id, m.seq FROM up
          CROSS JOIN ${this.#t.messages} m
            ON m.session_id = ? AND m.id = up.parent_id
          WHERE up.id <> ? AND m.seq >= ?
        )
        SELECT 1 AS hit FROM up WHERE id = ? LIMIT 1`,
        [sessionId, id, sessionId, ancestor.id, ancestor.seq, ancestor.id]
      ).length > 0
    );
  }

  // ── Annotations and session config (internal) ──────────────────────────
  //
  // An annotation is server-side data a first-party module keeps about one
  // message, by kind. It is never part of the message and never sent to a
  // client. It goes with its message and on clear. An overlay carries the
  // newest annotation of each kind from the rows it hides, so a reader of
  // the visible path never looks below an overlay for one.

  /** True when the session holds any annotation: a primary-key prefix probe. */
  #hasAnnotations(sessionId: string): boolean {
    return (
      this.io.sql<{ one: number }>(
        `SELECT 1 AS one FROM ${this.#t.annotations} WHERE session_id = ? LIMIT 1`,
        [sessionId]
      ).length > 0
    );
  }

  /**
   * For each kind, the newest annotation among what a new overlay over
   * `to` hides: what the walk shows from `to` down to, not including,
   * `resume` (the row the walk continues at below it; `''` for the root).
   * An older overlay counts as its summary, which carries the newest
   * annotation of what it hid, and the walk jumps past its rows, so the
   * cost follows what is visible, not what is stored. Bounded by `resume`,
   * not by the start row, because deletes keep `resume` right and can
   * remove the start. Ids only, no content. A read, so the walk runs
   * before the overlay's write transaction, never inside it.
   */
  #annotationsToCarry(
    sessionId: string,
    resume: string,
    toMessageId: string
  ): Array<{ kind: string; value: string }> {
    if (!this.#hasAnnotations(sessionId)) return [];
    return this.io.sql<{ kind: string; value: string }>(
      `WITH RECURSIVE
      stop(seq) AS (
        SELECT COALESCE(
          (SELECT seq FROM ${this.#t.messages}
           WHERE session_id = ?1 AND id = ?3),
          -1)
      ),
      -- The rows the walk shows from the end down to the continuation: at a row
      -- where an older overlay applies (the newest ending there with a
      -- known continuation), the walk jumps to that overlay's continuation,
      -- as reads do, instead of passing every row it hid. Along an ancestor
      -- chain seq falls, so the walk stops at or below the continuation.
      span(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM ${this.#t.messages}
        WHERE session_id = ?1 AND id = ?2
        UNION ALL
        SELECT next.id, next.parent_id, s.depth + 1 FROM span s
        CROSS JOIN ${this.#t.messages} next
          ON next.session_id = ?1 AND next.id = COALESCE(
            (SELECT c.resume_id FROM ${this.#t.compactions} c
             WHERE c.session_id = ?1 AND c.to_message_id = s.id
               AND c.resume_id IS NOT NULL
             ORDER BY c.seq DESC LIMIT 1),
            s.parent_id)
        WHERE next.seq > (SELECT seq FROM stop)
      ),
      found AS (
        SELECT a.kind, a.value, span.depth, 0 AS on_overlay
        FROM span CROSS JOIN ${this.#t.annotations} a
          ON a.session_id = ?1 AND a.message_id = span.id
        UNION ALL
        -- The overlay the walk applies at a row carries the newest
        -- annotation of what it hid (and any set on its summary message).
        -- It sits where it ends and outranks the row it hid there.
        SELECT a.kind, a.value, span.depth, 1 AS on_overlay
        FROM span
        CROSS JOIN ${this.#t.compactions} c
          ON c.session_id = ?1 AND c.to_message_id = span.id
            AND c.resume_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM ${this.#t.compactions} n
              WHERE n.session_id = ?1 AND n.to_message_id = c.to_message_id
                AND n.resume_id IS NOT NULL AND n.seq > c.seq)
        CROSS JOIN ${this.#t.annotations} a
          ON a.session_id = ?1 AND a.message_id = '${COMPACTION_PREFIX}' || c.id
      ),
      ranked AS (
        SELECT kind, value,
          ROW_NUMBER() OVER (
            PARTITION BY kind ORDER BY depth, on_overlay DESC
          ) AS rank
        FROM found
      )
      SELECT kind, value FROM ranked WHERE rank = 1`,
      [sessionId, toMessageId, resume]
    );
  }

  /** Annotations of `kind` for the given message ids; only annotated ids are returned. */
  annotations(
    sessionId: string,
    kind: string,
    messageIds: readonly string[]
  ): Map<string, string> {
    const found = new Map<string, string>();
    if (messageIds.length === 0) return found;
    const rows = this.io.sql<{ message_id: string; value: string }>(
      `SELECT message_id, value FROM ${this.#t.annotations}
       WHERE session_id = ? AND kind = ?
         AND message_id IN (SELECT value FROM json_each(?))`,
      [sessionId, kind, JSON.stringify(messageIds)]
    );
    for (const row of rows) found.set(row.message_id, row.value);
    return found;
  }

  setAnnotation(
    sessionId: string,
    kind: string,
    messageId: string,
    value: string
  ): void {
    this.io.sqlWrite(
      `INSERT INTO ${this.#t.annotations}
         (session_id, message_id, kind, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, message_id, kind)
         DO UPDATE SET value = excluded.value`,
      [sessionId, messageId, kind, value]
    );
  }

  /**
   * The newest annotation of `kind` among the messages `getHistory({ leafId })`
   * returns, overlay messages included: the visible walk from the leaf,
   * newest first, one indexed probe per batch of steps, stopping at the
   * first hit. A per-turn record near the leaf costs a few rows; nothing
   * proportional to the path or to the annotations stored is read or held.
   */
  latestAnnotation(
    sessionId: string,
    kind: string,
    leafId?: string | null
  ): { messageId: string; value: string } | null {
    if (!this.#hasAnnotations(sessionId)) return null;
    for (const batch of this.#walkBatches(
      sessionId,
      leafId,
      false,
      NEWEST_FIRST_WINDOW_ROWS
    )) {
      const ids = batch
        .filter((step) => !step.hidden)
        .map((step) =>
          step.overlayId === null
            ? step.id
            : `${COMPACTION_PREFIX}${step.overlayId}`
        );
      const found = this.annotations(sessionId, kind, ids);
      for (const messageId of ids) {
        const value = found.get(messageId);
        if (value !== undefined) return { messageId, value };
      }
    }
    return null;
  }

  config(sessionId: string, key: string): string | null {
    return (
      this.io.sql<{ value: string }>(
        `SELECT value FROM ${this.#t.config} WHERE session_id = ? AND key = ?`,
        [sessionId, key]
      )[0]?.value ?? null
    );
  }

  setConfig(sessionId: string, key: string, value: string | null): void {
    if (value === null) {
      this.io.sqlWrite(
        `DELETE FROM ${this.#t.config} WHERE session_id = ? AND key = ?`,
        [sessionId, key]
      );
      return;
    }
    this.io.sqlWrite(
      `INSERT INTO ${this.#t.config} (session_id, key, value)
       VALUES (?, ?, ?)
       ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value`,
      [sessionId, key, value]
    );
  }

  getCompactions(sessionId: string): StoredCompaction[] {
    return this.io
      .sql<CompactionRow>(
        `SELECT id, summary, from_message_id, to_message_id, created_at
         FROM ${this.#t.compactions}
         WHERE session_id = ? ORDER BY seq ASC`,
        [sessionId]
      )
      .map(toStoredCompaction);
  }

  // ── Search ───────────────────────────────────────────────────────────────

  search(sessionId: string, query: string, limit: number): SearchResult[] {
    this.#ensureFts();
    // Quote the query as a literal phrase, escaping embedded double quotes,
    // so user input cannot inject FTS5 syntax.
    const sanitized = `"${query.replace(/"/g, '""')}"`;
    return this.io
      .sql<{ id: string; role: string; content: string }>(
        `SELECT f.id, f.role, f.content FROM ${this.#t.fts} f
         INNER JOIN ${this.#t.messages} m
           ON m.session_id = f.session_id AND m.id = f.id
         WHERE ${this.#t.fts} MATCH ? AND f.session_id = ?
           AND NOT ${hiddenOverlayRowSql(this.#t, "f.id", "f.session_id")}
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
    const text = searchableText(message);
    if (replace) {
      const existing = this.io.sql<{ content: string; role: string }>(
        `SELECT content, role FROM ${this.#t.fts} WHERE id = ? AND session_id = ?`,
        [message.id, sessionId]
      );
      if (existing.length > 0) {
        if (existing[0].content === text && existing[0].role === message.role) {
          return;
        }
        this.io.sqlWrite(
          `DELETE FROM ${this.#t.fts} WHERE id = ? AND session_id = ?`,
          [message.id, sessionId]
        );
      }
    }
    if (text) {
      this.io.sqlWrite(
        `INSERT INTO ${this.#t.fts} (id, session_id, role, content) VALUES (?, ?, ?, ?)`,
        [message.id, sessionId, message.role, text]
      );
    }
  }

  // ── Import ───────────────────────────────────────────────────────────────

  /**
   * Import one historical message verbatim (migrations, cross-DO moves):
   * explicit parent and timestamp, stamped estimate, no change-feed events.
   */
  /** Returns `false` when the id already exists and nothing was written. */
  importMessage(
    sessionId: string,
    message: SessionMessage,
    options: { parentId: string | null; createdAt: number }
  ): boolean {
    const {
      message: staged,
      attachments,
      references
    } = extractAttachments(message);
    const json = JSON.stringify(staged);
    const slices = splitContent(json);
    const tail = this.#tail(sessionId);
    let inserted = 0;
    this.io.transaction(() => {
      for (const attachment of attachments) {
        this.#attachments.put(attachment.payload, attachment.hash);
      }
      inserted = this.io.sqlWrite(
        `INSERT OR IGNORE INTO ${this.#t.messages}
          (session_id, id, seq, parent_id, role, content, content_chunks, token_estimate, created_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          message.id,
          tail.nextSeq,
          options.parentId,
          message.role,
          slices[0],
          slices.length - 1,
          this.estimateRowTokens(message),
          options.createdAt,
          contentDigest(json)
        ]
      );
      if (inserted === 0) return;
      this.#writeContinuations(sessionId, message.id, slices);
      this.#attachments.addRefs(sessionId, message.id, references);
      this.#indexFts(sessionId, staged, false);
    });
    if (inserted === 0) return false;
    this.#appended(sessionId, tail, message.id);
    this.#pathTokens.delete(sessionId);
    return true;
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
