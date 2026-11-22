/**
 * The Inbox's SQLite rows. The store reads and writes; it decides nothing.
 * Every write the lane runner makes is guarded in SQL on the record's token
 * (never reused, unlike an id) and the attempt it holds, so a write that
 * lost a race changes nothing and says so.
 */

import { SqlError } from "../sql-error";
import type {
  InboxImport,
  InboxListOptions,
  InboxPurgeOptions,
  InboxRequest,
  InboxStatus,
  InboxTerminalStatus
} from "./types";

/** The default inbox's table. A named inbox has `cf_agents_inbox__<name>`. */
export const INBOX_TABLE = "cf_agents_inbox";

/**
 * The longest payload, result or progress JSON kept inline in the row.
 * A UTF-16 unit is at most three bytes of UTF-8, and metadata is capped at
 * {@link INBOX_METADATA_LIMIT}, so the three inline values and the metadata
 * together stay under SQLite's 2 MB row limit. Longer JSON is split across
 * the parts table.
 */
const INLINE_LIMIT = 160_000;

/** The longest metadata JSON a request may carry. */
export const INBOX_METADATA_LIMIT = 100_000;

/** The longest piece of split JSON in one parts row. */
const PIECE = 500_000;

const OPEN = "('pending', 'running')";
const TERMINAL = "('completed', 'error', 'aborted', 'skipped')";
const OPEN_SET: ReadonlySet<InboxStatus> = new Set(["pending", "running"]);

type Field = "payload" | "result" | "progress";

type Row = {
  id: string;
  token: string;
  kind: string;
  lane: string;
  seq: number;
  status: InboxStatus;
  idempotency_key: string | null;
  payload: string | null;
  payload_parts: number;
  metadata: string | null;
  progress: string | null;
  progress_parts: number;
  result: string | null;
  result_parts: number;
  error: string | null;
  policy: InboxRequest["policy"];
  overlap: number;
  debounce_until: number | null;
  merged: string | null;
  attempt: number;
  detached: number;
  notified: string | null;
  created_at: number;
  started_at: number | null;
  settled_at: number | null;
};

/** The row facts the runner needs that the public record leaves out. */
export type InboxRow = {
  readonly request: InboxRequest;
  /** Unique to this record: a later record under the same id has another. */
  readonly token: string;
  readonly overlap: boolean;
  readonly debounceUntil: number | null;
  /** The ids of the requests this one superseded, oldest first. */
  readonly merged: readonly string[];
  /** {@link merged} with each request's arrival `seq`. */
  readonly mergedEntries: readonly MergedEntry[];
  /** A terminal record whose terminal `onStatus` returned. */
  readonly reported: boolean;
};

/** A request a survivor superseded, with its arrival order. */
export type MergedEntry = { readonly id: string; readonly seq: number };

/** A new row, as {@link InboxStore.insert} takes it. */
export type InboxInsert = {
  readonly id: string;
  readonly token: string;
  readonly kind: string;
  readonly lane: string;
  readonly status: "pending" | "skipped";
  readonly idempotencyKey: string | null;
  /** The payload as JSON, or `null` for none. */
  readonly payload: string | null;
  readonly metadata: string | null;
  readonly policy: InboxRequest["policy"];
  readonly overlap: boolean;
  readonly debounceUntil: number | null;
  readonly error: string | null;
  readonly now: number;
};

export class InboxStore {
  readonly #storage: DurableObjectStorage;
  readonly #table: string;
  readonly #parts: string;
  #ready = false;

  /** @param name - A named inbox's name: lowercase letters and digits. */
  constructor(storage: DurableObjectStorage, name?: string) {
    this.#storage = storage;
    this.#table = name === undefined ? INBOX_TABLE : `${INBOX_TABLE}__${name}`;
    this.#parts = `${this.#table}_parts`;
  }

  #sql<T>(query: string, ...params: (string | number | null)[]): T[] {
    this.#ensure();
    try {
      return [...this.#storage.sql.exec(query, ...params)] as T[];
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  /** Run a write. Returns whether it changed a row. */
  #write(query: string, ...params: (string | number | null)[]): boolean {
    this.#ensure();
    try {
      return this.#storage.sql.exec(query, ...params).rowsWritten > 0;
    } catch (cause) {
      throw new SqlError(query, cause);
    }
  }

  #ensure(): void {
    if (this.#ready) return;
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ${this.#table} (
        id TEXT PRIMARY KEY NOT NULL,
        token TEXT NOT NULL,
        kind TEXT NOT NULL,
        lane TEXT NOT NULL,
        seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        payload TEXT,
        payload_parts INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        progress TEXT,
        progress_parts INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        result_parts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        policy TEXT NOT NULL,
        overlap INTEGER NOT NULL DEFAULT 0,
        debounce_until INTEGER,
        merged TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        detached INTEGER NOT NULL DEFAULT 0,
        notified TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        settled_at INTEGER
      )`);
    this.#storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS ${this.#table}_lane_idx
       ON ${this.#table} (lane, status, seq)`
    );
    this.#storage.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${this.#table}_token_idx
       ON ${this.#table} (token)`
    );
    this.#storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS ${this.#table}_settled_idx
       ON ${this.#table} (status, settled_at)`
    );
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ${this.#parts} (
        token TEXT NOT NULL,
        field TEXT NOT NULL,
        piece INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (token, field, piece)
      ) WITHOUT ROWID`);
    this.#ready = true;
  }

  /** Whether the table exists, without creating it. */
  exists(): boolean {
    if (this.#ready) return true;
    return (
      this.#storage.sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          this.#table
        )
        .toArray().length > 0
    );
  }

  // ── Reads ────────────────────────────────────────────────────────────

  get(id: string): InboxRow | undefined {
    const row = this.#sql<Row>(
      `SELECT * FROM ${this.#table} WHERE id = ?`,
      id
    )[0];
    return row ? this.#fromRow(row) : undefined;
  }

  byIdempotencyKey(key: string): InboxRow | undefined {
    const row = this.#sql<Row>(
      `SELECT * FROM ${this.#table} WHERE idempotency_key = ?`,
      key
    )[0];
    return row ? this.#fromRow(row) : undefined;
  }

  /** The stored payload JSON, joined from its parts, or `null` for none. */
  payloadJson(id: string): string | null {
    const row = this.#sql<{
      token: string;
      payload: string | null;
      payload_parts: number;
    }>(
      `SELECT token, payload, payload_parts FROM ${this.#table} WHERE id = ?`,
      id
    )[0];
    if (!row) return null;
    return row.payload_parts > 0
      ? this.#joinParts(row.token, "payload")
      : row.payload;
  }

  list(options: InboxListOptions = {}): InboxRequest[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.lane !== undefined) {
      where.push("lane = ?");
      params.push(options.lane);
    }
    if (options.kind !== undefined) {
      where.push("kind = ?");
      params.push(options.kind);
    }
    if (options.idempotencyKey !== undefined) {
      where.push("idempotency_key = ?");
      params.push(options.idempotencyKey);
    }
    const statuses =
      options.status === undefined
        ? []
        : typeof options.status === "string"
          ? [options.status]
          : [...options.status];
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    if (options.before !== undefined) {
      where.push("created_at < ?");
      params.push(options.before);
    }
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 500);
    const order = options.order === "oldest" ? "ASC" : "DESC";
    return this.#sql<Row>(
      `SELECT * FROM ${this.#table}
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY seq ${order}
       LIMIT ?`,
      ...params,
      limit
    ).map((row) => this.#fromRow(row).request);
  }

  /** The first open request of a lane a runner owns: not detached. */
  nextOpen(lane: string): InboxRow | undefined {
    const row = this.#sql<Row>(
      `SELECT * FROM ${this.#table}
       WHERE lane = ? AND status IN ${OPEN} AND detached = 0
       ORDER BY seq ASC LIMIT 1`,
      lane
    )[0];
    return row ? this.#fromRow(row) : undefined;
  }

  /** Whether a lane has an open request a runner owns. */
  busy(lane: string): boolean {
    if (!this.exists()) return false;
    return (
      this.#sql(
        `SELECT 1 FROM ${this.#table}
         WHERE lane = ? AND status IN ${OPEN} AND detached = 0 LIMIT 1`,
        lane
      ).length > 0
    );
  }

  /** Every lane with an open request a runner owns. */
  openLanes(): string[] {
    if (!this.exists()) return [];
    return this.#sql<{ lane: string }>(
      `SELECT DISTINCT lane FROM ${this.#table}
       WHERE status IN ${OPEN} AND detached = 0`
    ).map((row) => row.lane);
  }

  /** The ids and tokens of a lane's open requests, oldest first. */
  openTokens(
    lane: string,
    options: { includeDetached: boolean }
  ): Array<{ id: string; token: string }> {
    if (!this.exists()) return [];
    return this.#sql<{ id: string; token: string }>(
      `SELECT id, token FROM ${this.#table}
       WHERE lane = ? AND status IN ${OPEN}
       ${options.includeDetached ? "" : "AND detached = 0"}
       ORDER BY seq ASC`,
      lane
    );
  }

  /**
   * The id of the newest open overlapping request of a lane after `seq`,
   * which supersedes the request at `seq` when that one overlaps too. A
   * later request that already ended does not: it ran (or was cancelled)
   * without the earlier one's input.
   */
  supersededBy(lane: string, seq: number): string | undefined {
    return this.#sql<{ id: string }>(
      `SELECT id FROM ${this.#table}
       WHERE lane = ? AND overlap = 1 AND seq > ? AND status IN ${OPEN}
       ORDER BY seq DESC LIMIT 1`,
      lane,
      seq
    )[0]?.id;
  }

  /** Terminal requests whose terminal `onStatus` has not returned. */
  unreported(limit: number): Array<{ id: string; token: string }> {
    if (!this.exists()) return [];
    return this.#sql<{ id: string; token: string }>(
      `SELECT id, token FROM ${this.#table}
       WHERE status IN ${TERMINAL} AND (notified IS NULL OR notified != status)
       ORDER BY seq ASC LIMIT ?`,
      limit
    );
  }

  /** Ids of terminal requests settled before `time`, earliest first. */
  settledBefore(
    time: number,
    options: InboxPurgeOptions,
    limit: number
  ): string[] {
    if (!this.exists()) return [];
    const statuses =
      options.status === undefined
        ? ["completed", "error", "aborted", "skipped"]
        : typeof options.status === "string"
          ? [options.status]
          : [...options.status];
    if (statuses.length === 0) return [];
    const params: (string | number)[] = [time, ...statuses];
    let filter = "";
    if (options.lane !== undefined) {
      filter += " AND lane = ?";
      params.push(options.lane);
    }
    if (options.kind !== undefined) {
      filter += " AND kind = ?";
      params.push(options.kind);
    }
    return this.#sql<{ id: string }>(
      `SELECT id FROM ${this.#table}
       WHERE settled_at < ?
         AND status IN (${statuses.map(() => "?").join(", ")})${filter}
       ORDER BY settled_at ASC, seq ASC
       LIMIT ?`,
      ...params,
      limit
    ).map((row) => row.id);
  }

  // ── Writes ───────────────────────────────────────────────────────────

  insert(row: InboxInsert): void {
    const payload = this.#place(row.token, "payload", row.payload);
    this.#sql(
      `INSERT INTO ${this.#table}
         (id, token, kind, lane, seq, status, idempotency_key, payload,
          payload_parts, metadata, policy, overlap, debounce_until, error,
          created_at, settled_at)
       SELECT ?, ?, ?, ?, coalesce(max(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?
       FROM ${this.#table}`,
      row.id,
      row.token,
      row.kind,
      row.lane,
      row.status,
      row.idempotencyKey,
      payload.inline,
      payload.parts,
      row.metadata,
      row.policy,
      row.overlap ? 1 : 0,
      row.debounceUntil,
      row.error,
      row.now,
      row.status === "skipped" ? row.now : null
    );
  }

  /** Write a record moved from another store, after every row so far. */
  restore(record: InboxImport, token: string, metadata: string | null): void {
    const json = (value: unknown) =>
      value === undefined ? null : JSON.stringify(value);
    const payload = this.#place(token, "payload", json(record.payload));
    const result = this.#place(token, "result", json(record.result));
    const progress = this.#place(token, "progress", json(record.progress));
    const open = OPEN_SET.has(record.status);
    this.#sql(
      `INSERT INTO ${this.#table}
         (id, token, kind, lane, seq, status, idempotency_key, payload,
          payload_parts, metadata, progress, progress_parts, result,
          result_parts, error, policy, attempt, notified, created_at,
          started_at, settled_at)
       SELECT ?, ?, ?, ?, coalesce(max(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, 'queue', ?, ?, ?, ?, ?
       FROM ${this.#table}`,
      record.id,
      token,
      record.kind,
      record.lane ?? record.kind,
      record.status,
      record.idempotencyKey ?? null,
      payload.inline,
      payload.parts,
      metadata,
      progress.inline,
      progress.parts,
      result.inline,
      result.parts,
      record.error ?? null,
      record.status === "running"
        ? Math.max(1, record.attempt)
        : record.attempt,
      open ? null : record.status,
      record.createdAt,
      record.startedAt ?? null,
      open ? null : (record.settledAt ?? record.createdAt)
    );
  }

  /**
   * Start attempt `attempt` of an open record whose stored attempt is
   * `attempt - 1`. Returns false when another write got there first.
   */
  start(token: string, attempt: number, now: number): boolean {
    return this.#write(
      `UPDATE ${this.#table}
       SET status = 'running', attempt = ?, started_at = coalesce(started_at, ?)
       WHERE token = ? AND status IN ${OPEN} AND detached = 0 AND attempt = ?`,
      attempt,
      now,
      token,
      attempt - 1
    );
  }

  /** Whether the record `token` names is still running attempt `attempt`. */
  holds(token: string, attempt: number): boolean {
    return (
      this.#sql(
        `SELECT 1 FROM ${this.#table}
         WHERE token = ? AND status = 'running' AND attempt = ?`,
        token,
        attempt
      ).length > 0
    );
  }

  /** Mark a running attempt handed off. */
  detach(token: string, attempt: number): boolean {
    return this.#write(
      `UPDATE ${this.#table} SET detached = 1
       WHERE token = ? AND status = 'running' AND attempt = ?`,
      token,
      attempt
    );
  }

  /** Add to the requests a survivor superseded, keeping their order. */
  addMerged(id: string, entries: readonly MergedEntry[]): void {
    const current = this.get(id);
    if (!current) return;
    const byId = new Map(current.mergedEntries.map((e) => [e.id, e]));
    for (const entry of entries) byId.set(entry.id, entry);
    const merged = [...byId.values()].sort((a, b) => a.seq - b.seq);
    this.#write(
      `UPDATE ${this.#table} SET merged = ? WHERE id = ?`,
      JSON.stringify(merged),
      id
    );
  }

  /**
   * End an open record. `from` names the statuses it may end from, and
   * `attempt`, when given, the attempt that must still hold it.
   */
  settle(
    token: string,
    to: InboxTerminalStatus,
    fields: { result?: string | null; error?: string | null; now: number },
    guard: { from: "open" | "running" | "pending"; attempt?: number }
  ): boolean {
    const from =
      guard.from === "open"
        ? OPEN
        : guard.from === "running"
          ? "('running')"
          : "('pending')";
    // Guard first, so a write that lost a race leaves no parts behind.
    const current = this.#sql<{ id: string }>(
      `SELECT id FROM ${this.#table} WHERE token = ? AND status IN ${from}
       ${guard.attempt === undefined ? "" : "AND attempt = ?"}`,
      token,
      ...(guard.attempt === undefined ? [] : [guard.attempt])
    );
    if (current.length === 0) return false;
    const result = this.#place(token, "result", fields.result ?? null);
    this.#sql(
      `UPDATE ${this.#table}
       SET status = ?, result = ?, result_parts = ?, error = ?, settled_at = ?
       WHERE token = ?`,
      to,
      result.inline,
      result.parts,
      fields.error ?? null,
      fields.now,
      token
    );
    return true;
  }

  /** Record that the terminal `onStatus` for `status` returned. */
  reported(token: string, status: InboxStatus): void {
    if (OPEN_SET.has(status)) return;
    this.#write(
      `UPDATE ${this.#table} SET notified = ? WHERE token = ? AND status = ?`,
      status,
      token,
      status
    );
  }

  /** Write a request's progress. Returns false when there is no such request. */
  checkpoint(id: string, progress: string | null): boolean {
    const row = this.#sql<{ token: string }>(
      `SELECT token FROM ${this.#table} WHERE id = ?`,
      id
    )[0];
    if (!row) return false;
    const placed = this.#place(row.token, "progress", progress);
    return this.#write(
      `UPDATE ${this.#table} SET progress = ?, progress_parts = ? WHERE id = ?`,
      placed.inline,
      placed.parts,
      id
    );
  }

  /** Delete a terminal request. */
  delete(id: string): boolean {
    if (!this.exists()) return false;
    const row = this.#sql<{ token: string }>(
      `SELECT token FROM ${this.#table} WHERE id = ? AND status IN ${TERMINAL}`,
      id
    )[0];
    if (!row) return false;
    this.#sql(`DELETE FROM ${this.#table} WHERE token = ?`, row.token);
    this.#sql(`DELETE FROM ${this.#parts} WHERE token = ?`, row.token);
    return true;
  }

  // ── Parts ────────────────────────────────────────────────────────────

  /** Keep `json` inline when it is short, or split it into parts. */
  #place(
    token: string,
    field: Field,
    json: string | null
  ): { inline: string | null; parts: number } {
    this.#sql(
      `DELETE FROM ${this.#parts} WHERE token = ? AND field = ?`,
      token,
      field
    );
    if (json === null || json.length <= INLINE_LIMIT) {
      return { inline: json, parts: 0 };
    }
    const pieces = splitPieces(json, PIECE);
    pieces.forEach((data, piece) => {
      this.#sql(
        `INSERT INTO ${this.#parts} (token, field, piece, data)
         VALUES (?, ?, ?, ?)`,
        token,
        field,
        piece,
        data
      );
    });
    return { inline: null, parts: pieces.length };
  }

  #joinParts(token: string, field: Field): string {
    return this.#sql<{ data: string }>(
      `SELECT data FROM ${this.#parts}
       WHERE token = ? AND field = ? ORDER BY piece ASC`,
      token,
      field
    )
      .map((row) => row.data)
      .join("");
  }

  #fromRow(row: Row): InboxRow {
    const resultJson =
      row.result_parts > 0 ? this.#joinParts(row.token, "result") : row.result;
    const progressJson =
      row.progress_parts > 0
        ? this.#joinParts(row.token, "progress")
        : row.progress;
    const metadata = parseJson(row.metadata);
    const merged = parseJson(row.merged);
    const mergedEntries: MergedEntry[] = Array.isArray(merged)
      ? merged.filter(
          (entry): entry is MergedEntry =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as MergedEntry).id === "string" &&
            typeof (entry as MergedEntry).seq === "number"
        )
      : [];
    const request: InboxRequest = {
      id: row.id,
      kind: row.kind,
      lane: row.lane,
      seq: row.seq,
      status: row.status,
      attempt: row.attempt,
      policy: row.policy,
      ...(row.idempotency_key !== null && {
        idempotencyKey: row.idempotency_key
      }),
      ...(isRecord(metadata) && { metadata }),
      ...(progressJson !== null && { progress: parseJson(progressJson) }),
      ...(resultJson !== null && { result: parseJson(resultJson) }),
      ...(row.error !== null && { error: row.error }),
      detached: row.detached === 1,
      createdAt: row.created_at,
      ...(row.started_at !== null && { startedAt: row.started_at }),
      ...(row.settled_at !== null && { settledAt: row.settled_at })
    };
    return {
      request,
      token: row.token,
      overlap: row.overlap === 1,
      debounceUntil: row.debounce_until,
      merged: mergedEntries.map((entry) => entry.id),
      mergedEntries,
      reported: !OPEN_SET.has(row.status) && row.notified === row.status
    };
  }
}

/**
 * `text` in pieces of at most `size` code units, never between the two
 * halves of a surrogate pair: SQLite stores text as UTF-8, which cannot
 * hold half a pair.
 */
export function splitPieces(text: string, size: number): string[] {
  const pieces: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(text.slice(at, end));
    at = end;
  }
  return pieces;
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
