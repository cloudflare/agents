import type { DriverError, DriverSubmission } from "./types";

type SubmissionRow = {
  seq: number;
  runtime_id: string;
  scope: string;
  operation_id: string;
  input_json: string;
  status: "queued" | "running";
  submitted_at: number;
  started_at: number | null;
  attempts: number;
  failure_json: string | null;
  stop_requested: number;
};

/** A submission plus the failure the driver still owes an `onFail` for. */
export type StoredSubmission<Input = unknown> = DriverSubmission<Input> & {
  readonly failure: DriverError | null;
};

const COLUMNS = `seq, runtime_id, scope, operation_id, input_json, status,
  submitted_at, started_at, attempts, failure_json, stop_requested`;

function decodeRow<Input>(row: SubmissionRow): StoredSubmission<Input> {
  return {
    runtimeId: row.runtime_id,
    scope: row.scope,
    id: row.operation_id,
    input: JSON.parse(row.input_json) as Input,
    status: row.status,
    submittedAt: row.submitted_at,
    startedAt: row.started_at,
    attempt: row.attempts,
    stopRequested: row.stop_requested === 1,
    failure:
      row.failure_json === null
        ? null
        : (JSON.parse(row.failure_json) as DriverError)
  };
}

/** One runtime's rows in the shared submissions table. */
export class DriverStore {
  readonly #storage: DurableObjectStorage;
  readonly #runtimeId: string;
  #ready = false;

  constructor(storage: DurableObjectStorage, runtimeId: string) {
    if (runtimeId.trim() === "") throw new Error("runtimeId must not be empty");
    this.#storage = storage;
    this.#runtimeId = runtimeId;
  }

  ensureTable(): void {
    if (this.#ready) return;
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_driver_submissions (
        seq INTEGER PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running')),
        submitted_at INTEGER NOT NULL,
        started_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        failure_json TEXT,
        stop_requested INTEGER NOT NULL DEFAULT 0,
        UNIQUE (runtime_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS cf_agents_driver_scope_queue
        ON cf_agents_driver_submissions (runtime_id, scope, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS cf_agents_driver_scope_running
        ON cf_agents_driver_submissions (runtime_id, scope)
        WHERE status = 'running';
    `);
    this.#ready = true;
  }

  enqueue<Input>(
    scope: string,
    id: string,
    input: Input
  ): { accepted: boolean; submission: StoredSubmission<Input> } {
    this.ensureTable();
    if (scope.trim() === "") throw new Error("scope must not be empty");
    if (id.trim() === "") throw new Error("id must not be empty");
    const inputJSON = JSON.stringify(input);
    if (inputJSON === undefined) {
      throw new Error("input must be JSON-serializable");
    }
    const cursor = this.#storage.sql.exec(
      `INSERT INTO cf_agents_driver_submissions
        (runtime_id, scope, operation_id, input_json, status, submitted_at)
       VALUES (?, ?, ?, ?, 'queued', ?)
       ON CONFLICT (runtime_id, operation_id) DO NOTHING`,
      this.#runtimeId,
      scope,
      id,
      inputJSON,
      Date.now()
    );
    const submission = this.get<Input>(id);
    if (!submission) throw new Error(`Failed to enqueue operation ${id}`);
    return { accepted: cursor.rowsWritten > 0, submission };
  }

  get<Input = unknown>(id: string): StoredSubmission<Input> | undefined {
    this.ensureTable();
    const row = this.#storage.sql
      .exec<SubmissionRow>(
        `SELECT ${COLUMNS} FROM cf_agents_driver_submissions
         WHERE runtime_id = ? AND operation_id = ?`,
        this.#runtimeId,
        id
      )
      .toArray()[0];
    return row ? decodeRow<Input>(row) : undefined;
  }

  /** The oldest submission in a scope: the one the driver steps. */
  head<Input = unknown>(scope: string): StoredSubmission<Input> | undefined {
    this.ensureTable();
    const row = this.#storage.sql
      .exec<SubmissionRow>(
        `SELECT ${COLUMNS} FROM cf_agents_driver_submissions
         WHERE runtime_id = ? AND scope = ?
         ORDER BY seq ASC LIMIT 1`,
        this.#runtimeId,
        scope
      )
      .toArray()[0];
    return row ? decodeRow<Input>(row) : undefined;
  }

  list<Input = unknown>(scope?: string): StoredSubmission<Input>[] {
    this.ensureTable();
    const rows =
      scope === undefined
        ? this.#storage.sql
            .exec<SubmissionRow>(
              `SELECT ${COLUMNS} FROM cf_agents_driver_submissions
               WHERE runtime_id = ? ORDER BY seq ASC`,
              this.#runtimeId
            )
            .toArray()
        : this.#storage.sql
            .exec<SubmissionRow>(
              `SELECT ${COLUMNS} FROM cf_agents_driver_submissions
               WHERE runtime_id = ? AND scope = ? ORDER BY seq ASC`,
              this.#runtimeId,
              scope
            )
            .toArray();
    return rows.map((row) => decodeRow<Input>(row));
  }

  scopes(): string[] {
    this.ensureTable();
    return this.#storage.sql
      .exec<{ scope: string; first_seq: number }>(
        `SELECT scope, MIN(seq) AS first_seq
         FROM cf_agents_driver_submissions
         WHERE runtime_id = ?
         GROUP BY scope ORDER BY first_seq ASC`,
        this.#runtimeId
      )
      .toArray()
      .map((row) => row.scope);
  }

  markRunning(id: string, startedAt = Date.now()): void {
    this.ensureTable();
    this.#storage.sql.exec(
      `UPDATE cf_agents_driver_submissions
       SET status = 'running', started_at = ?
       WHERE runtime_id = ? AND operation_id = ? AND status = 'queued'`,
      startedAt,
      this.#runtimeId,
      id
    );
  }

  recordAttempt(id: string, attempts: number, failure: DriverError | null) {
    this.ensureTable();
    this.#storage.sql.exec(
      `UPDATE cf_agents_driver_submissions
       SET attempts = ?, failure_json = ?
       WHERE runtime_id = ? AND operation_id = ?`,
      attempts,
      failure === null ? null : JSON.stringify(failure),
      this.#runtimeId,
      id
    );
  }

  resetAttempts(id: string): void {
    this.ensureTable();
    this.#storage.sql.exec(
      `UPDATE cf_agents_driver_submissions
       SET attempts = 0
       WHERE runtime_id = ? AND operation_id = ? AND failure_json IS NULL`,
      this.#runtimeId,
      id
    );
  }

  requestStop(id: string): void {
    this.ensureTable();
    this.#storage.sql.exec(
      `UPDATE cf_agents_driver_submissions
       SET stop_requested = 1
       WHERE runtime_id = ? AND operation_id = ?`,
      this.#runtimeId,
      id
    );
  }

  remove(id: string): boolean {
    this.ensureTable();
    return (
      this.#storage.sql.exec(
        `DELETE FROM cf_agents_driver_submissions
         WHERE runtime_id = ? AND operation_id = ?`,
        this.#runtimeId,
        id
      ).rowsWritten > 0
    );
  }
}
