import type {
  StoredSubmission,
  SubmissionAcceptance,
  SubmissionEnvelope,
  SubmissionInput,
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

type SubmissionIdRow = Record<string, SqlStorageValue> & {
  submission_id: string;
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
    this.#insert(envelope);
    return { envelope, state: "pending" };
  }

  /**
   * Creates one pending submission or returns the identity previously claimed
   * by the input's idempotency key.
   */
  accept(input: SubmissionInput): SubmissionAcceptance {
    const envelope: SubmissionEnvelope = {
      ...input,
      schemaVersion: 1,
      submissionId: `sub_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString()
    };

    if (this.#insert(envelope, true)) {
      return { outcome: "accepted", submissionId: envelope.submissionId };
    }

    const [existing] = this.#sql
      .exec<SubmissionIdRow>(
        `SELECT submission_id
         FROM cf_channels_submissions
         WHERE idempotency_key = ?`,
        input.idempotencyKey
      )
      .toArray();

    if (existing === undefined) {
      throw new Error("The idempotency claim disappeared during acceptance");
    }

    return {
      outcome: "duplicate",
      submissionId: existing.submission_id
    };
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

  #insert(envelope: SubmissionEnvelope, ignoreDuplicateKey = false): boolean {
    const conflictClause = ignoreDuplicateKey
      ? "ON CONFLICT (idempotency_key) DO NOTHING"
      : "";
    const inserted = this.#sql
      .exec<SubmissionIdRow>(
        `INSERT INTO cf_channels_submissions (
          submission_id,
          idempotency_key,
          envelope_json,
          state
        ) VALUES (?, ?, ?, 'pending')
        ${conflictClause}
        RETURNING submission_id`,
        envelope.submissionId,
        envelope.idempotencyKey,
        JSON.stringify(envelope)
      )
      .toArray();

    return inserted.length === 1;
  }
}
