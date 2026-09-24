import type { OpenCodeRequest } from "./machine";
import type { OCPendingSubmission } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cf_agents_oc_submissions (
  seq INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request TEXT NOT NULL,
  submitted_at INTEGER NOT NULL
)`;

type Row = {
  seq: number;
  session_id: string;
  operation_id: string;
  request: string;
  submitted_at: number;
};

export type QueuedSubmission = OCPendingSubmission & { readonly seq: number };

function toSubmission(row: Row): QueuedSubmission {
  return {
    seq: row.seq,
    sessionId: row.session_id,
    operationId: row.operation_id,
    // SAFETY: rows are written only by `insert()` from a validated request.
    request: JSON.parse(row.request) as OpenCodeRequest,
    submittedAt: row.submitted_at
  };
}

/**
 * Durable intake queue of turns the harness accepted but OpenCode has not yet
 * taken into its inbox.
 *
 * This is the piece that makes `submit()` honest: the row is written *before*
 * the machine run starts, so a crash between the two is repaired on the next
 * wake instead of silently losing the user's message.
 */
export class OpenCodeSubmissions {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  ensureTable(): void {
    this.#storage.sql.exec(SCHEMA);
  }

  insert(
    sessionId: string,
    operationId: string,
    request: OpenCodeRequest
  ): QueuedSubmission {
    const submittedAt = Date.now();
    this.#storage.sql.exec(
      `INSERT INTO cf_agents_oc_submissions
        (session_id, operation_id, request, submitted_at) VALUES (?, ?, ?, ?)`,
      sessionId,
      operationId,
      JSON.stringify(request),
      submittedAt
    );
    const row = this.#storage.sql
      .exec<{ seq: number }>("SELECT last_insert_rowid() AS seq")
      .one();
    return { seq: row.seq, sessionId, operationId, request, submittedAt };
  }

  list(sessionId?: string): QueuedSubmission[] {
    const rows =
      sessionId === undefined
        ? this.#storage.sql
            .exec<Row>(
              `SELECT seq, session_id, operation_id, request, submitted_at
               FROM cf_agents_oc_submissions ORDER BY seq ASC`
            )
            .toArray()
        : this.#storage.sql
            .exec<Row>(
              `SELECT seq, session_id, operation_id, request, submitted_at
               FROM cf_agents_oc_submissions WHERE session_id = ?
               ORDER BY seq ASC`,
              sessionId
            )
            .toArray();
    return rows.map(toSubmission);
  }

  has(operationId: string): boolean {
    return (
      this.#storage.sql
        .exec<{ seq: number }>(
          "SELECT seq FROM cf_agents_oc_submissions WHERE operation_id = ? LIMIT 1",
          operationId
        )
        .toArray().length > 0
    );
  }

  /** Remove a pending submission by operation id; false when absent. */
  deleteOperation(operationId: string): boolean {
    const cursor = this.#storage.sql.exec(
      "DELETE FROM cf_agents_oc_submissions WHERE operation_id = ?",
      operationId
    );
    return cursor.rowsWritten > 0;
  }
}
