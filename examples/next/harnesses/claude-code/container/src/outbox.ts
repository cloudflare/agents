/**
 * The daemon's durable outbox: a `node:sqlite` database on the container
 * disk holding every frame the engine has produced, the applied-key ledger
 * that makes `deliver()` idempotent, the open request rows and a small
 * key/value table for the runtime id and the prior exit.
 *
 * The outbox is what survives a dropped control socket: the Durable Object
 * re-subscribes from the last seq it ingested and the frames it missed are
 * replayed in order. It does not survive the container, which is why the
 * runtime id is a generation marker rather than an identity.
 *
 * Two rules the rest of the daemon depends on. Seq is assigned inside the
 * same transaction as the insert, so the sequence is monotonic and gap-free
 * per generation. And every row read back is re-keyed into a plain object:
 * `node:sqlite` returns null-prototype rows, which hang a Cap'n Web consumer
 * on the other side of the wire.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../../../shared/src/types.ts";

/** Where the outbox lives inside the image. */
export const OUTBOX_DIR = "/var/lib/harnessd";
/** Frames below the floor are dropped once the outbox passes this size. */
export const OUTBOX_MAX_BYTES = 64 * 1024 * 1024;

/** One durable frame, as the daemon stores and replays it. */
export type OutboxFrame = {
  readonly seq: number;
  readonly operationId: string | null;
  readonly at: number;
  readonly body: JsonValue;
};

/** A request the engine opened and nobody has answered yet. */
export type OutboxRequest = {
  readonly requestId: string;
  readonly operationId: string | null;
  readonly payload: JsonValue;
  readonly expiresAt: number;
};

type FrameRow = {
  seq: number;
  operation_id: string | null;
  body: string;
  at: number;
};
type RequestRow = {
  request_id: string;
  operation_id: string | null;
  payload: string;
  expires_at: number;
};

/**
 * Pick a writable path for the database. The image owns `/var/lib/harnessd`;
 * a daemon run outside it (a developer's laptop, a test) falls back to the
 * temp directory so the outbox still works.
 */
export function defaultOutboxPath(): string {
  try {
    mkdirSync(OUTBOX_DIR, { recursive: true });
    return join(OUTBOX_DIR, "outbox.db");
  } catch {
    return join(tmpdir(), "harnessd-outbox.db");
  }
}

export class Outbox {
  readonly #db: DatabaseSync;
  readonly #session: string;
  readonly #maxBytes: number;
  #highWaterSeq = 0;
  #floorSeq = 0;
  #bytes = 0;

  constructor(options: {
    readonly session: string;
    readonly path?: string;
    readonly maxBytes?: number;
  }) {
    this.#session = options.session;
    this.#db = new DatabaseSync(options.path ?? defaultOutboxPath());
    this.#maxBytes = options.maxBytes ?? OUTBOX_MAX_BYTES;
    // WAL keeps the append path off the reader's back; an in-memory database
    // rejects the pragma, which is fine because there is nothing to recover.
    try {
      this.#db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // In-memory databases have no journal to switch.
    }
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS frames(
         session TEXT NOT NULL,
         seq INTEGER NOT NULL,
         operation_id TEXT,
         body TEXT NOT NULL,
         at INTEGER NOT NULL,
         PRIMARY KEY(session, seq)
       ) WITHOUT ROWID;
       CREATE TABLE IF NOT EXISTS applied(key TEXT PRIMARY KEY, seq INTEGER NOT NULL);
       CREATE TABLE IF NOT EXISTS requests(
         request_id TEXT PRIMARY KEY,
         operation_id TEXT,
         payload TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`
    );
    const bounds = this.#db
      .prepare(
        "SELECT MIN(seq) AS lo, MAX(seq) AS hi, SUM(LENGTH(body)) AS bytes FROM frames WHERE session = ?"
      )
      .get(this.#session) as
      | { lo: number | null; hi: number | null; bytes: number | null }
      | undefined;
    // The high-water mark outlives the frames: a fully pruned outbox must
    // not hand a reopened daemon seq 1 again while the runtime id, and so
    // the Durable Object's cursor, carry on from the old generation.
    const remembered = Number(this.getMeta(this.#highWaterKey()) ?? 0);
    this.#highWaterSeq = Math.max(Number(bounds?.hi ?? 0), remembered);
    this.#floorSeq =
      bounds?.lo === null || bounds?.lo === undefined
        ? this.#highWaterSeq === 0
          ? 0
          : this.#highWaterSeq + 1
        : Number(bounds.lo);
    this.#bytes = Number(bounds?.bytes ?? 0);
  }

  #highWaterKey(): string {
    return `highWaterSeq:${this.#session}`;
  }

  get highWaterSeq(): number {
    return this.#highWaterSeq;
  }

  /** The lowest seq still held. A subscriber below it has lost frames. */
  get floorSeq(): number {
    return this.#floorSeq;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /**
   * Append one batch, assigning seq inside the transaction. Returns the
   * frames as stored so the caller can hand them straight to a subscriber.
   */
  append(
    entries: readonly {
      readonly operationId: string | null;
      readonly body: JsonValue;
    }[]
  ): readonly OutboxFrame[] {
    if (entries.length === 0) return [];
    const insert = this.#db.prepare(
      "INSERT INTO frames(session, seq, operation_id, body, at) VALUES(?, ?, ?, ?, ?)"
    );
    const remember = this.#db.prepare(
      "INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)"
    );
    const at = Date.now();
    const appended: OutboxFrame[] = [];
    let bytes = 0;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      let seq = this.#highWaterSeq;
      for (const entry of entries) {
        seq += 1;
        const body = JSON.stringify(entry.body);
        insert.run(this.#session, seq, entry.operationId, body, at);
        bytes += body.length;
        appended.push({
          seq,
          operationId: entry.operationId,
          at,
          body: entry.body
        });
      }
      remember.run(this.#highWaterKey(), String(seq));
      this.#db.exec("COMMIT");
      // Accounting follows the commit, so a rolled-back batch counts nothing.
      this.#highWaterSeq = seq;
      this.#bytes += bytes;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    if (this.#floorSeq === 0) this.#floorSeq = appended[0]!.seq;
    this.#capBytes();
    return appended;
  }

  /**
   * Frames after `fromSeq`, oldest first, within both budgets. At least one
   * frame is always returned when one exists, so an oversized frame cannot
   * stall the stream.
   */
  replay(
    fromSeq: number,
    maxFrames: number,
    maxBytes: number
  ): readonly OutboxFrame[] {
    const rows = this.#db
      .prepare(
        "SELECT seq, operation_id, body, at FROM frames WHERE session = ? AND seq > ? ORDER BY seq LIMIT ?"
      )
      .all(this.#session, fromSeq, Math.max(1, maxFrames)) as FrameRow[];
    const frames: OutboxFrame[] = [];
    let bytes = 0;
    for (const row of rows) {
      if (frames.length > 0 && bytes + row.body.length > maxBytes) break;
      bytes += row.body.length;
      // Re-key: node:sqlite hands back null-prototype rows.
      frames.push({
        seq: Number(row.seq),
        operationId:
          row.operation_id === null ? null : String(row.operation_id),
        at: Number(row.at),
        body: JSON.parse(String(row.body)) as JsonValue
      });
    }
    return frames;
  }

  /**
   * Record an inbox row as applied. False means it was applied before, which
   * is how a redelivery is recognised.
   */
  /** True when a delivery with this key was already taken by the engine. */
  isApplied(key: string): boolean {
    return (
      this.#db.prepare("SELECT key FROM applied WHERE key = ?").get(key) !==
      undefined
    );
  }

  /** Record a delivery the engine took. Idempotent. */
  markApplied(key: string, seq: number): boolean {
    if (this.isApplied(key)) return false;
    this.#db
      .prepare("INSERT INTO applied(key, seq) VALUES(?, ?)")
      .run(key, seq);
    return true;
  }

  /** The most recently applied keys, newest last, bounded for the hello answer. */
  appliedKeys(limit: number): readonly string[] {
    const rows = this.#db
      .prepare("SELECT key FROM applied ORDER BY seq DESC LIMIT ?")
      .all(limit) as { key: string }[];
    return rows.map((row) => String(row.key)).reverse();
  }

  openRequest(request: OutboxRequest): void {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO requests(request_id, operation_id, payload, expires_at) VALUES(?, ?, ?, ?)"
      )
      .run(
        request.requestId,
        request.operationId,
        JSON.stringify(request.payload),
        request.expiresAt
      );
  }

  closeRequest(requestId: string): void {
    this.#db
      .prepare("DELETE FROM requests WHERE request_id = ?")
      .run(requestId);
  }

  setRequestDeadline(requestId: string, expiresAt: number): void {
    this.#db
      .prepare("UPDATE requests SET expires_at = ? WHERE request_id = ?")
      .run(expiresAt, requestId);
  }

  openRequests(): readonly OutboxRequest[] {
    const rows = this.#db
      .prepare(
        "SELECT request_id, operation_id, payload, expires_at FROM requests ORDER BY expires_at"
      )
      .all() as RequestRow[];
    return rows.map((row) => ({
      requestId: String(row.request_id),
      operationId: row.operation_id === null ? null : String(row.operation_id),
      payload: JSON.parse(String(row.payload)) as JsonValue,
      expiresAt: Number(row.expires_at)
    }));
  }

  getMeta(key: string): string | undefined {
    const row = this.#db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row === undefined ? undefined : String(row.value);
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)")
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.#db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  /** Drop everything at or below `seq`. Advisory: the ack said it is durable elsewhere. */
  prune(seq: number): void {
    if (seq <= 0) return;
    this.#dropTo(seq);
  }

  close(): void {
    this.#db.close();
  }

  /** Raise the floor until the outbox fits its byte cap. */
  #capBytes(): void {
    while (
      this.#bytes > this.#maxBytes &&
      this.#floorSeq <= this.#highWaterSeq
    ) {
      // Drop a tenth of the window at a time: one statement per pass rather
      // than one per frame.
      const step = Math.max(
        1,
        Math.ceil((this.#highWaterSeq - this.#floorSeq + 1) / 10)
      );
      this.#dropTo(this.#floorSeq + step - 1);
    }
  }

  #dropTo(seq: number): void {
    const dropped = this.#db
      .prepare(
        "SELECT SUM(LENGTH(body)) AS bytes FROM frames WHERE session = ? AND seq <= ?"
      )
      .get(this.#session, seq) as { bytes: number | null } | undefined;
    this.#db
      .prepare("DELETE FROM frames WHERE session = ? AND seq <= ?")
      .run(this.#session, seq);
    this.#bytes = Math.max(0, this.#bytes - Number(dropped?.bytes ?? 0));
    this.#floorSeq = Math.min(seq + 1, this.#highWaterSeq + 1);
  }
}
