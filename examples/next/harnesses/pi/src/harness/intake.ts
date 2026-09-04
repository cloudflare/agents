import type { PiOperationRequest, PiPendingSubmission } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cf_agents_pi_submissions (
  seq INTEGER PRIMARY KEY,
  lane TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request TEXT NOT NULL,
  submitted_at INTEGER NOT NULL
)`;

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
