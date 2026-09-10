import type { PiOperationRequest, PiPendingSubmission } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cf_agents_pi_submissions (
  seq INTEGER PRIMARY KEY,
  lane TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request TEXT NOT NULL,
  submitted_at INTEGER NOT NULL
)`;

/**
 * Terminal record of a submission that never became an operation.
 *
 * Additive to {@link SCHEMA}: an existing database gains the table on its
 * next start and keeps every pending row it already had.
 */
const DISPOSITION_SCHEMA = `
CREATE TABLE IF NOT EXISTS cf_agents_pi_dispositions (
  operation_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  kind TEXT NOT NULL,
  command TEXT,
  created_at INTEGER NOT NULL
)`;

/**
 * How many dispositions one Durable Object keeps.
 *
 * The rows are an idempotency window, not a log: they exist so a client
 * retrying a submission it never got a receipt for is answered instead of
 * re-run. Keeping every one would grow the object's storage for the life of
 * the session, so the newest {@link MAX_DISPOSITIONS} survive and older ones
 * are dropped. A retry that arrives after its row was pruned is treated as a
 * new submission — the window is far longer than any client's retry.
 */
export const MAX_DISPOSITIONS = 1024;

/**
 * What became of a submission the harness consumed out of band.
 *
 * `claimed` is the transient state: the row exists from before the `input`
 * handler or the slash command runs until its outcome is known. A row left
 * in it is a submission whose isolate died mid-handler — the handler may have
 * run in part, so the retry is refused rather than replayed. Out-of-band
 * commands are at-most-once.
 */
export type PiDispositionKind = "claimed" | "handled" | "command";

/** A submission's terminal (or in-flight) out-of-band disposition. */
export type PiDisposition = {
  readonly operationId: string;
  readonly lane: string;
  readonly kind: PiDispositionKind;
  /** The extension slash command that ran, for `kind: "command"`. */
  readonly command?: string;
  readonly createdAt: number;
};

type DispositionRow = {
  operation_id: string;
  lane: string;
  kind: string;
  command: string | null;
  created_at: number;
};

function rowToDisposition(row: DispositionRow): PiDisposition {
  return {
    operationId: row.operation_id,
    lane: row.lane,
    kind:
      row.kind === "handled" || row.kind === "command" ? row.kind : "claimed",
    ...(row.command === null ? {} : { command: row.command }),
    createdAt: row.created_at
  };
}

type SubmissionRow = {
  seq: number;
  lane: string;
  operation_id: string;
  request: string;
  submitted_at: number;
};

/** A pending submission together with its durable queue position. */
export type QueuedSubmission = PiPendingSubmission & { readonly seq: number };

function rowToSubmission(row: SubmissionRow): QueuedSubmission {
  return {
    seq: row.seq,
    lane: row.lane,
    operationId: row.operation_id,
    // SAFETY: rows are written only by `insert()` from a validated request.
    request: JSON.parse(row.request) as PiOperationRequest,
    submittedAt: row.submitted_at
  };
}

/**
 * Durable intake queue of operations the harness accepted but pi has not yet
 * admitted, ordered per lane. The `seq` rowid alias is the table's key, so a
 * submission costs one row write to add and one to remove; the table is
 * small (rows live only until admission) and needs no index.
 */
export class PiSubmissions {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  ensureTable(): void {
    this.#storage.sql.exec(SCHEMA);
    this.#storage.sql.exec(DISPOSITION_SCHEMA);
  }

  /**
   * Claim an operation id for out-of-band handling, atomically.
   *
   * False means the id was already claimed — by a retry of this submission,
   * or by the submission itself before an eviction — and the caller must run
   * no handler for it. The row is the only durable trace an `input` handler
   * or a slash command leaves, so it has to exist before either runs.
   */
  claim(lane: string, operationId: string): boolean {
    const cursor = this.#storage.sql.exec(
      `INSERT INTO cf_agents_pi_dispositions
        (operation_id, lane, kind, command, created_at)
       VALUES (?, ?, 'claimed', NULL, ?)
       ON CONFLICT(operation_id) DO NOTHING`,
      operationId,
      lane,
      Date.now()
    );
    return cursor.rowsWritten > 0;
  }

  /**
   * Record what a claimed submission turned out to be, and drop the
   * dispositions that have aged out of the retention window.
   *
   * Settling is the only point a row becomes terminal, so it is where the
   * table is bounded: the newest {@link MAX_DISPOSITIONS} rows stay and the
   * rest go, in the same synchronous block as the update.
   */
  settle(
    operationId: string,
    kind: "handled" | "command",
    command?: string
  ): void {
    this.#storage.sql.exec(
      `UPDATE cf_agents_pi_dispositions
         SET kind = ?, command = ?
       WHERE operation_id = ?`,
      kind,
      command ?? null,
      operationId
    );
    // `created_at` is a millisecond clock, so rows written in the same tick
    // tie; the rowid breaks the tie in insertion order.
    this.#storage.sql.exec(
      `DELETE FROM cf_agents_pi_dispositions
        WHERE rowid NOT IN (
          SELECT rowid FROM cf_agents_pi_dispositions
           ORDER BY created_at DESC, rowid DESC LIMIT ?
        )`,
      MAX_DISPOSITIONS
    );
  }

  /**
   * Drop a claim: the submission is an ordinary operation after all, and the
   * queue row it is about to get is its idempotency record.
   */
  release(operationId: string): void {
    this.#storage.sql.exec(
      "DELETE FROM cf_agents_pi_dispositions WHERE operation_id = ?",
      operationId
    );
  }

  /** The out-of-band disposition of an operation id, when it has one. */
  disposition(operationId: string): PiDisposition | undefined {
    const row = this.#storage.sql
      .exec<DispositionRow>(
        `SELECT operation_id, lane, kind, command, created_at
         FROM cf_agents_pi_dispositions WHERE operation_id = ? LIMIT 1`,
        operationId
      )
      .toArray()[0];
    return row ? rowToDisposition(row) : undefined;
  }

  insert(
    lane: string,
    operationId: string,
    request: PiOperationRequest
  ): QueuedSubmission {
    const submittedAt = Date.now();
    this.#storage.sql.exec(
      `INSERT INTO cf_agents_pi_submissions
        (lane, operation_id, request, submitted_at)
       VALUES (?, ?, ?, ?)`,
      lane,
      operationId,
      JSON.stringify(request),
      submittedAt
    );
    const row = this.#storage.sql
      .exec<{ seq: number }>("SELECT last_insert_rowid() AS seq")
      .one();
    return { seq: row.seq, lane, operationId, request, submittedAt };
  }

  /** The oldest pending submission on a lane. */
  head(lane: string): QueuedSubmission | undefined {
    const row = this.#storage.sql
      .exec<SubmissionRow>(
        `SELECT seq, lane, operation_id, request, submitted_at
         FROM cf_agents_pi_submissions WHERE lane = ?
         ORDER BY seq ASC LIMIT 1`,
        lane
      )
      .toArray()[0];
    return row ? rowToSubmission(row) : undefined;
  }

  list(lane?: string): QueuedSubmission[] {
    const rows =
      lane === undefined
        ? this.#storage.sql
            .exec<SubmissionRow>(
              `SELECT seq, lane, operation_id, request, submitted_at
               FROM cf_agents_pi_submissions ORDER BY seq ASC`
            )
            .toArray()
        : this.#storage.sql
            .exec<SubmissionRow>(
              `SELECT seq, lane, operation_id, request, submitted_at
               FROM cf_agents_pi_submissions WHERE lane = ?
               ORDER BY seq ASC`,
              lane
            )
            .toArray();
    return rows.map(rowToSubmission);
  }

  has(operationId: string): boolean {
    return (
      this.#storage.sql
        .exec<{ seq: number }>(
          "SELECT seq FROM cf_agents_pi_submissions WHERE operation_id = ? LIMIT 1",
          operationId
        )
        .toArray().length > 0
    );
  }

  /** Lanes with at least one pending submission. */
  lanes(): string[] {
    return this.#storage.sql
      .exec<{ lane: string }>(
        "SELECT DISTINCT lane FROM cf_agents_pi_submissions"
      )
      .toArray()
      .map((row) => row.lane);
  }

  delete(seq: number): void {
    this.#storage.sql.exec(
      "DELETE FROM cf_agents_pi_submissions WHERE seq = ?",
      seq
    );
  }

  /** Remove a pending submission by operation id; false when absent. */
  deleteOperation(operationId: string): boolean {
    const cursor = this.#storage.sql.exec(
      "DELETE FROM cf_agents_pi_submissions WHERE operation_id = ?",
      operationId
    );
    return cursor.rowsWritten > 0;
  }
}
