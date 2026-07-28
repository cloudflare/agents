import type { AgentDelivery } from "../agent-deliveries";
import { equivalentSubmissionInput } from "../submission-equivalence";
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

const CREATE_AGENT_DELIVERIES_TABLE = `CREATE TABLE IF NOT EXISTS cf_channels_agent_deliveries (
  submission_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (submission_id)
    REFERENCES cf_channels_submissions (submission_id)
)`;

/** Synchronous Durable Object storage required by the submission ledger. */
export interface SubmissionStorage {
  /** SQLite storage containing submission and logical delivery records. */
  sql: SqlStorage;
  /** Execute related ledger changes in one atomic transaction. */
  transactionSync<T>(closure: () => T): T;
}

type SubmissionRow = Record<string, SqlStorageValue> & {
  envelope_json: string;
  state: SubmissionState;
};

type AcceptedSubmissionRow = SubmissionRow & {
  submission_id: string;
};

type AgentDeliveryRow = Record<string, SqlStorageValue> & {
  submission_id: string;
  turn_id: string;
};

/** Persists immutable submissions in a Durable Object's SQLite storage. */
export class SubmissionStore {
  readonly #storage: SubmissionStorage;
  readonly #sql: SqlStorage;

  constructor(storage: SubmissionStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
    this.#sql.exec(CREATE_SUBMISSIONS_TABLE);
    this.#sql.exec(CREATE_IDEMPOTENCY_INDEX);
    this.#sql.exec(CREATE_AGENT_DELIVERIES_TABLE);
  }

  /**
   * Atomically creates one pending submission and logical turn, or recognizes
   * input previously claimed by the same idempotency key.
   */
  accept(input: SubmissionInput): SubmissionAcceptance {
    return this.#storage.transactionSync(() => {
      const existing = this.#findByIdempotencyKey(input.idempotencyKey);
      if (existing !== undefined) {
        const existingEnvelope = JSON.parse(
          existing.envelope_json
        ) as SubmissionEnvelope;
        if (!equivalentSubmissionInput(existingEnvelope, input)) {
          return { outcome: "conflict" };
        }
        return {
          outcome: "duplicate",
          submissionId: existing.submission_id
        };
      }

      const envelope: SubmissionEnvelope = {
        ...input,
        schemaVersion: 1,
        submissionId: `sub_${crypto.randomUUID()}`,
        createdAt: new Date().toISOString()
      };
      const delivery: AgentDelivery = {
        submissionId: envelope.submissionId,
        turnId: `turn_${crypto.randomUUID()}`
      };

      this.#insertSubmission(envelope);
      this.#insertAgentDelivery(delivery);

      return { outcome: "accepted", submissionId: envelope.submissionId };
    });
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

  getAgentDelivery(submissionId: string): AgentDelivery | undefined {
    const [row] = this.#sql
      .exec<AgentDeliveryRow>(
        `SELECT submission_id, turn_id
         FROM cf_channels_agent_deliveries
         WHERE submission_id = ?`,
        submissionId
      )
      .toArray();

    return row === undefined
      ? undefined
      : { submissionId: row.submission_id, turnId: row.turn_id };
  }

  #findByIdempotencyKey(
    idempotencyKey: string
  ): AcceptedSubmissionRow | undefined {
    return this.#sql
      .exec<AcceptedSubmissionRow>(
        `SELECT submission_id, envelope_json, state
         FROM cf_channels_submissions
         WHERE idempotency_key = ?`,
        idempotencyKey
      )
      .toArray()[0];
  }

  #insertSubmission(envelope: SubmissionEnvelope): void {
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
  }

  #insertAgentDelivery(delivery: AgentDelivery): void {
    this.#sql.exec(
      `INSERT INTO cf_channels_agent_deliveries (submission_id, turn_id)
       VALUES (?, ?)`,
      delivery.submissionId,
      delivery.turnId
    );
  }
}
