import {
  AGENT_DELIVERY_ERROR_DESCRIPTION_MAX_LENGTH,
  type AgentDeliveryAttempt,
  type AgentDeliveryAttemptCompletion,
  type ClaimedAgentDeliveryAttempt
} from "../agent-delivery-attempts";
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

const CREATE_AGENT_DELIVERY_ATTEMPTS_TABLE = `CREATE TABLE IF NOT EXISTS cf_channels_agent_delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT CHECK (outcome IN ('dispatch_returned', 'dispatch_error')),
  error_description TEXT CHECK (
    error_description IS NULL OR length(error_description) <= 1024
  ),
  CHECK (
    (ended_at IS NULL AND outcome IS NULL AND error_description IS NULL)
    OR
    (ended_at IS NOT NULL AND outcome = 'dispatch_returned'
      AND error_description IS NULL)
    OR
    (ended_at IS NOT NULL AND outcome = 'dispatch_error'
      AND error_description IS NOT NULL)
  ),
  UNIQUE (submission_id, attempt_number),
  FOREIGN KEY (submission_id)
    REFERENCES cf_channels_agent_deliveries (submission_id)
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

type AgentDeliveryAttemptRow = Record<string, SqlStorageValue> & {
  attempt_id: string;
  submission_id: string;
  turn_id: string;
  attempt_number: number;
  started_at: string;
  ended_at: string | null;
  outcome: "dispatch_returned" | "dispatch_error" | null;
  error_description: string | null;
};

type ClaimableDeliveryRow = AgentDeliveryRow & {
  envelope_json: string;
  state: "pending" | "retrying";
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
    this.#sql.exec(CREATE_AGENT_DELIVERY_ATTEMPTS_TABLE);
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

  /**
   * Atomically claims eligible delivery work and creates its physical attempt.
   * The returned records are the only inputs authorized for that request.
   */
  beginAgentDeliveryAttempt(
    submissionId: string
  ): ClaimedAgentDeliveryAttempt | undefined {
    return this.#storage.transactionSync(() => {
      const [row] = this.#sql
        .exec<ClaimableDeliveryRow>(
          `SELECT s.envelope_json, s.state, d.submission_id, d.turn_id
           FROM cf_channels_submissions AS s
           JOIN cf_channels_agent_deliveries AS d
             ON d.submission_id = s.submission_id
           WHERE s.submission_id = ?
             AND s.state IN ('pending', 'retrying')`,
          submissionId
        )
        .toArray();
      if (row === undefined) {
        return undefined;
      }

      const transition = this.#sql.exec(
        `UPDATE cf_channels_submissions
         SET state = 'delivering'
         WHERE submission_id = ? AND state = ?`,
        submissionId,
        row.state
      );
      if (transition.rowsWritten !== 1) {
        return undefined;
      }

      const [{ next_attempt_number }] = this.#sql
        .exec<Record<string, SqlStorageValue> & { next_attempt_number: number }>(
          `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt_number
           FROM cf_channels_agent_delivery_attempts
           WHERE submission_id = ?`,
          submissionId
        )
        .toArray();
      const attempt: AgentDeliveryAttempt = {
        attemptId: `attempt_${crypto.randomUUID()}`,
        submissionId,
        turnId: row.turn_id,
        attemptNumber: next_attempt_number,
        startedAt: new Date().toISOString()
      };
      this.#sql.exec(
        `INSERT INTO cf_channels_agent_delivery_attempts (
          attempt_id,
          submission_id,
          attempt_number,
          started_at
        ) VALUES (?, ?, ?, ?)`,
        attempt.attemptId,
        attempt.submissionId,
        attempt.attemptNumber,
        attempt.startedAt
      );

      return {
        attempt,
        submission: JSON.parse(row.envelope_json) as SubmissionEnvelope,
        delivery: { submissionId, turnId: row.turn_id }
      };
    });
  }

  /**
   * Records how an active dispatch invocation settled and releases its claim.
   * Until an acknowledgement contract exists, either raw dispatch result is
   * unacknowledged and returns the submission to retrying.
   */
  completeAgentDeliveryAttempt(
    attemptId: string,
    completion: AgentDeliveryAttemptCompletion
  ): AgentDeliveryAttempt | undefined {
    return this.#storage.transactionSync(() => {
      const [active] = this.#sql
        .exec<Record<string, SqlStorageValue> & { submission_id: string }>(
          `SELECT a.submission_id
           FROM cf_channels_agent_delivery_attempts AS a
           JOIN cf_channels_submissions AS s
             ON s.submission_id = a.submission_id
           WHERE a.attempt_id = ?
             AND a.ended_at IS NULL
             AND s.state = 'delivering'`,
          attemptId
        )
        .toArray();
      if (active === undefined) {
        return undefined;
      }

      const endedAt = new Date().toISOString();
      this.#sql.exec(
        `UPDATE cf_channels_agent_delivery_attempts
         SET ended_at = ?, outcome = ?, error_description = ?
         WHERE attempt_id = ?`,
        endedAt,
        completion.outcome,
        completion.outcome === "dispatch_error"
          ? completion.errorDescription.slice(
              0,
              AGENT_DELIVERY_ERROR_DESCRIPTION_MAX_LENGTH
            )
          : null,
        attemptId
      );
      const transition = this.#sql.exec(
        `UPDATE cf_channels_submissions
         SET state = 'retrying'
         WHERE submission_id = ? AND state = 'delivering'`,
        active.submission_id
      );
      if (transition.rowsWritten !== 1) {
        throw new Error(
          `Submission ${active.submission_id} lost ownership of attempt ${attemptId}`
        );
      }
      return this.getAgentDeliveryAttempt(attemptId);
    });
  }

  getAgentDeliveryAttempt(
    attemptId: string
  ): AgentDeliveryAttempt | undefined {
    const [row] = this.#sql
      .exec<AgentDeliveryAttemptRow>(
        `SELECT a.attempt_id, a.submission_id, d.turn_id,
                a.attempt_number, a.started_at, a.ended_at,
                a.outcome, a.error_description
         FROM cf_channels_agent_delivery_attempts AS a
         JOIN cf_channels_agent_deliveries AS d
           ON d.submission_id = a.submission_id
         WHERE a.attempt_id = ?`,
        attemptId
      )
      .toArray();
    return row === undefined ? undefined : agentDeliveryAttemptFromRow(row);
  }

  listAgentDeliveryAttempts(submissionId: string): AgentDeliveryAttempt[] {
    return this.#sql
      .exec<AgentDeliveryAttemptRow>(
        `SELECT a.attempt_id, a.submission_id, d.turn_id,
                a.attempt_number, a.started_at, a.ended_at,
                a.outcome, a.error_description
         FROM cf_channels_agent_delivery_attempts AS a
         JOIN cf_channels_agent_deliveries AS d
           ON d.submission_id = a.submission_id
         WHERE a.submission_id = ?
         ORDER BY a.attempt_number`,
        submissionId
      )
      .toArray()
      .map(agentDeliveryAttemptFromRow);
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

function agentDeliveryAttemptFromRow(
  row: AgentDeliveryAttemptRow
): AgentDeliveryAttempt {
  return {
    attemptId: row.attempt_id,
    submissionId: row.submission_id,
    turnId: row.turn_id,
    attemptNumber: row.attempt_number,
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.error_description === null
      ? {}
      : { errorDescription: row.error_description })
  };
}
