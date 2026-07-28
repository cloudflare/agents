import type {
  StoredSubmission,
  SubmissionEnvelope,
  SubmissionState
} from "../submissions";

const CREATE_SUBMISSIONS_TABLE = `CREATE TABLE IF NOT EXISTS cf_channels_submissions (
  submission_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'pending',
      'delivering',
      'retrying',
      'delivered',
      'failed',
      'cancelled'
    )
  )
)`;

const CREATE_IDEMPOTENCY_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS
  cf_channels_submissions_idempotency_key
  ON cf_channels_submissions (idempotency_key)`;

type SubmissionRow = Record<string, SqlStorageValue> & {
  envelope_json: string;
  state: SubmissionState;
};

/** Persists immutable submissions in a Durable Object's SQLite storage. */
export class SubmissionStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#sql.exec(CREATE_SUBMISSIONS_TABLE);
    this.#sql.exec(CREATE_IDEMPOTENCY_INDEX);
  }

  persist(envelope: SubmissionEnvelope): StoredSubmission {
    this.#sql.exec(
      `INSERT INTO cf_channels_submissions (
        submission_id,
        idempotency_key,
        envelope_json,
        state
      ) VALUES (?, ?, ?, 'pending')`,
      envelope.submissionId,
      envelope.idempotencyKey,
      JSON.stringify(envelope)
    );

    return { envelope, state: "pending" };
  }

  get(submissionId: string): StoredSubmission | undefined {
    const [row] = this.#sql
      .exec<SubmissionRow>(
        `SELECT envelope_json, state
         FROM cf_channels_submissions
         WHERE submission_id = ?`,
        submissionId
      )
      .toArray();

    if (row === undefined) {
      return undefined;
    }

    return {
      envelope: JSON.parse(row.envelope_json) as SubmissionEnvelope,
      state: row.state
    };
  }
}
