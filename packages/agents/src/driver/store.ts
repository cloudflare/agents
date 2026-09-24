import type {
  HarnessDriverEnqueueResult,
  HarnessDriverSubmission
} from "./types";

type SubmissionRow = {
  seq: number;
  driver_id: string;
  scope: string;
  operation_id: string;
  input_json: string;
  status: "queued" | "admitted";
  stream_id: string | null;
  submitted_at: number;
  admitted_at: number | null;
};

function decodeRow<Input>(row: SubmissionRow): HarnessDriverSubmission<Input> {
  return {
    seq: row.seq,
    driverId: row.driver_id,
    scope: row.scope,
    operationId: row.operation_id,
    input: JSON.parse(row.input_json) as Input,
    status: row.status,
    streamId: row.stream_id,
    submittedAt: row.submitted_at,
    admittedAt: row.admitted_at
  };
}

export class HarnessDriverStore {
  readonly #storage: DurableObjectStorage;
  readonly #driverId: string;
  #ready = false;

  constructor(storage: DurableObjectStorage, driverId: string) {
    if (driverId.trim() === "") throw new Error("driverId must not be empty");
    this.#storage = storage;
    this.#driverId = driverId;
  }

  ensureTable(): void {
    if (this.#ready) return;
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_harness_submissions (
        seq INTEGER PRIMARY KEY,
        driver_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'admitted')),
        stream_id TEXT,
        submitted_at INTEGER NOT NULL,
        admitted_at INTEGER,
        UNIQUE (driver_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS cf_agents_harness_scope_queue
        ON cf_agents_harness_submissions (driver_id, scope, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS cf_agents_harness_scope_admitted
        ON cf_agents_harness_submissions (driver_id, scope)
        WHERE status = 'admitted';
    `);
    this.#ready = true;
  }

  enqueue<Input>(
    scope: string,
    operationId: string,
    input: Input,
    streamId: string | null
  ): HarnessDriverEnqueueResult<Input> {
    this.ensureTable();
    if (scope.trim() === "") throw new Error("scope must not be empty");
    if (operationId.trim() === "") {
      throw new Error("operationId must not be empty");
    }
    const inputJson = JSON.stringify(input);
    if (inputJson === undefined)
      throw new Error("input must be JSON-serializable");
    const cursor = this.#storage.sql.exec(
      `INSERT INTO cf_agents_harness_submissions
        (driver_id, scope, operation_id, input_json, status, stream_id,
         submitted_at, admitted_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL)
       ON CONFLICT (driver_id, operation_id) DO NOTHING`,
      this.#driverId,
      scope,
      operationId,
      inputJson,
      streamId,
      Date.now()
    );
    const submission = this.get<Input>(operationId);
    if (!submission)
      throw new Error(`Failed to enqueue operation ${operationId}`);
    return { accepted: cursor.rowsWritten > 0, submission };
  }

  get<Input = unknown>(
    operationId: string
  ): HarnessDriverSubmission<Input> | undefined {
    this.ensureTable();
    const row = this.#storage.sql
      .exec<SubmissionRow>(
        `SELECT seq, driver_id, scope, operation_id, input_json, status,
                stream_id, submitted_at, admitted_at
         FROM cf_agents_harness_submissions
         WHERE driver_id = ? AND operation_id = ?`,
        this.#driverId,
        operationId
      )
      .toArray()[0];
    return row ? decodeRow<Input>(row) : undefined;
  }

  head<Input = unknown>(
    scope: string
  ): HarnessDriverSubmission<Input> | undefined {
    this.ensureTable();
    const row = this.#storage.sql
      .exec<SubmissionRow>(
        `SELECT seq, driver_id, scope, operation_id, input_json, status,
                stream_id, submitted_at, admitted_at
         FROM cf_agents_harness_submissions
         WHERE driver_id = ? AND scope = ?
         ORDER BY seq ASC LIMIT 1`,
        this.#driverId,
        scope
      )
      .toArray()[0];
    return row ? decodeRow<Input>(row) : undefined;
  }

  admitted<Input = unknown>(
    scope: string
  ): HarnessDriverSubmission<Input> | undefined {
    this.ensureTable();
    const row = this.#storage.sql
      .exec<SubmissionRow>(
        `SELECT seq, driver_id, scope, operation_id, input_json, status,
                stream_id, submitted_at, admitted_at
         FROM cf_agents_harness_submissions
         WHERE driver_id = ? AND scope = ? AND status = 'admitted'`,
        this.#driverId,
        scope
      )
      .toArray()[0];
    return row ? decodeRow<Input>(row) : undefined;
  }

  list<Input = unknown>(scope?: string): HarnessDriverSubmission<Input>[] {
    this.ensureTable();
    const rows =
      scope === undefined
        ? this.#storage.sql
            .exec<SubmissionRow>(
              `SELECT seq, driver_id, scope, operation_id, input_json, status,
                      stream_id, submitted_at, admitted_at
               FROM cf_agents_harness_submissions
               WHERE driver_id = ? ORDER BY seq ASC`,
              this.#driverId
            )
            .toArray()
        : this.#storage.sql
            .exec<SubmissionRow>(
              `SELECT seq, driver_id, scope, operation_id, input_json, status,
                      stream_id, submitted_at, admitted_at
               FROM cf_agents_harness_submissions
               WHERE driver_id = ? AND scope = ? ORDER BY seq ASC`,
              this.#driverId,
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
         FROM cf_agents_harness_submissions
         WHERE driver_id = ?
         GROUP BY scope ORDER BY first_seq ASC`,
        this.#driverId
      )
      .toArray()
      .map((row) => row.scope);
  }

  markAdmitted<Input = unknown>(
    operationId: string,
    admittedAt = Date.now()
  ): HarnessDriverSubmission<Input> | undefined {
    this.ensureTable();
    this.#storage.sql.exec(
      `UPDATE cf_agents_harness_submissions
       SET status = 'admitted', admitted_at = ?
       WHERE driver_id = ? AND operation_id = ?`,
      admittedAt,
      this.#driverId,
      operationId
    );
    return this.get<Input>(operationId);
  }

  remove(operationId: string): boolean {
    this.ensureTable();
    return (
      this.#storage.sql.exec(
        `DELETE FROM cf_agents_harness_submissions
         WHERE driver_id = ? AND operation_id = ?`,
        this.#driverId,
        operationId
      ).rowsWritten > 0
    );
  }
}
