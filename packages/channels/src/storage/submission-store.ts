import {
  AGENT_DELIVERY_ERROR_DESCRIPTION_MAX_LENGTH,
  type AgentDeliveryAttempt,
  type AgentDeliveryAttemptCompletion,
  type ClaimedAgentDeliveryAttempt
} from "../agent-delivery-attempts";
import type { AgentDelivery } from "../agent-deliveries";
import {
  DEFAULT_DELIVERY_POLICY,
  type DeliveryPolicy,
  retryDelayMs
} from "../delivery-policy";
import { equivalentSubmissionInput } from "../submission-equivalence";
import type {
  StoredSubmission,
  SubmissionAcceptance,
  SubmissionCancellationResult,
  SubmissionEnvelope,
  SubmissionInput,
  SubmissionReplay,
  SubmissionReplayResult,
  SubmissionState,
  SubmissionStatus
} from "../submissions";

const CREATE_SUBMISSIONS_TABLE = `CREATE TABLE IF NOT EXISTS cf_channels_submissions (
  submission_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'pending',
      'delivering',
      'retrying',
      'delivered',
      'failed',
      'cancelled'
    )
  ),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_attempt_at TEXT,
  lease_expires_at TEXT,
  cycle_started_at TEXT NOT NULL,
  cycle_attempt_base INTEGER NOT NULL DEFAULT 0,
  terminal_error TEXT CHECK (
    terminal_error IS NULL OR length(terminal_error) <= 1024
  ),
  CHECK ((state = 'delivering') = (lease_expires_at IS NOT NULL)),
  CHECK (state IN ('pending', 'retrying') OR next_attempt_at IS NULL),
  CHECK (state = 'failed' OR terminal_error IS NULL)
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
  outcome TEXT CHECK (
    outcome IN (
      'acknowledged',
      'unacknowledged',
      'timeout',
      'retryable_error',
      'permanent_error',
      'lease_expired'
    )
  ),
  error_description TEXT CHECK (
    error_description IS NULL OR length(error_description) <= 1024
  ),
  CHECK (
    (ended_at IS NULL AND outcome IS NULL AND error_description IS NULL)
    OR
    (ended_at IS NOT NULL AND outcome = 'acknowledged'
      AND error_description IS NULL)
    OR
    (ended_at IS NOT NULL
      AND outcome IN ('unacknowledged', 'timeout', 'lease_expired'))
    OR
    (ended_at IS NOT NULL
      AND outcome IN ('retryable_error', 'permanent_error')
      AND error_description IS NOT NULL)
  ),
  UNIQUE (submission_id, attempt_number),
  FOREIGN KEY (submission_id)
    REFERENCES cf_channels_agent_deliveries (submission_id)
)`;

const CREATE_SUBMISSION_REPLAYS_TABLE = `CREATE TABLE IF NOT EXISTS cf_channels_submission_replays (
  replay_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
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

/** Injectable dependencies that make delivery schedules deterministic. */
export interface SubmissionStoreOptions {
  /** Overrides applied on top of {@link DEFAULT_DELIVERY_POLICY}. */
  policy?: Partial<DeliveryPolicy>;
  /** Millisecond epoch clock; defaults to `Date.now`. */
  clock?: () => number;
  /** Uniform [0, 1) source for retry jitter; defaults to `Math.random`. */
  random?: () => number;
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
  outcome: AgentDeliveryAttempt["outcome"] | null;
  error_description: string | null;
};

type ClaimableDeliveryRow = AgentDeliveryRow & {
  envelope_json: string;
  state: "pending" | "retrying";
  next_attempt_at: string | null;
  cycle_started_at: string;
};

type CycleStateRow = Record<string, SqlStorageValue> & {
  submission_id: string;
  retry_count: number;
  cycle_started_at: string;
  cycle_attempt_base: number;
};

type StatusRow = Record<string, SqlStorageValue> & {
  submission_id: string;
  turn_id: string;
  state: SubmissionState;
  envelope_json: string;
  created_at: string;
  retry_count: number;
  next_attempt_at: string | null;
  lease_expires_at: string | null;
  terminal_error: string | null;
  attempt_count: number;
  replay_count: number;
  last_outcome: AgentDeliveryAttempt["outcome"] | null;
  last_attempt_at: string | null;
};

/** Persists immutable submissions in a Durable Object's SQLite storage. */
export class SubmissionStore {
  readonly #storage: SubmissionStorage;
  readonly #sql: SqlStorage;
  readonly #policy: DeliveryPolicy;
  readonly #clock: () => number;
  readonly #random: () => number;

  constructor(
    storage: SubmissionStorage,
    options: SubmissionStoreOptions = {}
  ) {
    this.#storage = storage;
    this.#sql = storage.sql;
    this.#policy = { ...DEFAULT_DELIVERY_POLICY, ...options.policy };
    this.#clock = options.clock ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#sql.exec(CREATE_SUBMISSIONS_TABLE);
    this.#sql.exec(CREATE_IDEMPOTENCY_INDEX);
    this.#sql.exec(CREATE_AGENT_DELIVERIES_TABLE);
    this.#sql.exec(CREATE_AGENT_DELIVERY_ATTEMPTS_TABLE);
    this.#sql.exec(CREATE_SUBMISSION_REPLAYS_TABLE);
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
        createdAt: new Date(this.#clock()).toISOString()
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
   * Returns the delivery-progress projection of one submission, excluding the
   * payload and conversation hint.
   */
  getStatus(submissionId: string): SubmissionStatus | undefined {
    const [row] = this.#sql
      .exec<StatusRow>(
        `SELECT s.submission_id, d.turn_id, s.state, s.envelope_json,
                s.created_at, s.retry_count, s.next_attempt_at,
                s.lease_expires_at, s.terminal_error,
                (SELECT COUNT(*)
                   FROM cf_channels_agent_delivery_attempts AS a
                   WHERE a.submission_id = s.submission_id) AS attempt_count,
                (SELECT COUNT(*)
                   FROM cf_channels_submission_replays AS r
                   WHERE r.submission_id = s.submission_id) AS replay_count,
                (SELECT a.outcome
                   FROM cf_channels_agent_delivery_attempts AS a
                   WHERE a.submission_id = s.submission_id
                   ORDER BY a.attempt_number DESC
                   LIMIT 1) AS last_outcome,
                (SELECT a.started_at
                   FROM cf_channels_agent_delivery_attempts AS a
                   WHERE a.submission_id = s.submission_id
                   ORDER BY a.attempt_number DESC
                   LIMIT 1) AS last_attempt_at
         FROM cf_channels_submissions AS s
         JOIN cf_channels_agent_deliveries AS d
           ON d.submission_id = s.submission_id
         WHERE s.submission_id = ?`,
        submissionId
      )
      .toArray();
    if (row === undefined) {
      return undefined;
    }

    const envelope = JSON.parse(row.envelope_json) as SubmissionEnvelope;
    return {
      submissionId: row.submission_id,
      turnId: row.turn_id,
      state: row.state,
      agentTarget: envelope.agentTarget,
      sourceType: envelope.source.type,
      createdAt: row.created_at,
      attemptCount: row.attempt_count,
      retryCount: row.retry_count,
      replayCount: row.replay_count,
      ...(row.next_attempt_at === null
        ? {}
        : { nextAttemptAt: row.next_attempt_at }),
      ...(row.lease_expires_at === null
        ? {}
        : { leaseExpiresAt: row.lease_expires_at }),
      ...(row.last_outcome === null ? {} : { lastOutcome: row.last_outcome }),
      ...(row.last_attempt_at === null
        ? {}
        : { lastAttemptAt: row.last_attempt_at }),
      ...(row.terminal_error === null
        ? {}
        : { terminalError: row.terminal_error })
    };
  }

  /** Lists submission statuses, most recently accepted first. */
  listStatuses(limit = 50): SubmissionStatus[] {
    const rows = this.#sql
      .exec<Record<string, SqlStorageValue> & { submission_id: string }>(
        `SELECT submission_id
         FROM cf_channels_submissions
         ORDER BY created_at DESC, submission_id DESC
         LIMIT ?`,
        limit
      )
      .toArray();
    const statuses: SubmissionStatus[] = [];
    for (const row of rows) {
      const status = this.getStatus(row.submission_id);
      if (status !== undefined) {
        statuses.push(status);
      }
    }
    return statuses;
  }

  /**
   * Atomically claims eligible delivery work and creates its physical attempt.
   * The returned records are the only inputs authorized for that request.
   *
   * A submission is eligible when it is `pending` or `retrying`, its scheduled
   * next-attempt time has been reached, and its delivery cycle is within the
   * configured age limit. A `delivering` submission whose lease has expired is
   * first recovered to `retrying` with a scheduled retry; recovery never
   * claims within the same call, so a hot recovery loop cannot bypass backoff.
   */
  beginAgentDeliveryAttempt(
    submissionId: string
  ): ClaimedAgentDeliveryAttempt | undefined {
    return this.#storage.transactionSync(() => {
      this.#recoverExpiredLease(submissionId);

      const [row] = this.#sql
        .exec<ClaimableDeliveryRow>(
          `SELECT s.envelope_json, s.state, s.next_attempt_at,
                  s.cycle_started_at, d.submission_id, d.turn_id
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

      const now = this.#clock();
      if (
        row.next_attempt_at !== null &&
        Date.parse(row.next_attempt_at) > now
      ) {
        return undefined;
      }
      if (now - Date.parse(row.cycle_started_at) > this.#policy.maxCycleAgeMs) {
        this.#failSubmission(
          submissionId,
          row.state,
          `Delivery age limit of ${this.#policy.maxCycleAgeMs}ms reached before another attempt could start`
        );
        return undefined;
      }

      const transition = this.#sql.exec(
        `UPDATE cf_channels_submissions
         SET state = 'delivering',
             lease_expires_at = ?,
             next_attempt_at = NULL
         WHERE submission_id = ? AND state = ?`,
        new Date(now + this.#policy.leaseDurationMs).toISOString(),
        submissionId,
        row.state
      );
      if (transition.rowsWritten !== 1) {
        return undefined;
      }

      const [{ next_attempt_number }] = this.#sql
        .exec<
          Record<string, SqlStorageValue> & { next_attempt_number: number }
        >(
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
        startedAt: new Date(now).toISOString()
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
   * Records how an active dispatch invocation settled and applies the
   * resulting state transition:
   *
   * - `acknowledged` completes delivery;
   * - `permanent_error` fails the submission immediately;
   * - `unacknowledged`, `timeout`, and `retryable_error` schedule a retry
   *   with bounded exponential backoff, or fail the submission once the
   *   cycle's attempt or age limit is reached.
   *
   * A stale call — the attempt already settled, was recovered by lease
   * expiry, or the submission left `delivering` — records nothing, cannot
   * regress state, and returns undefined.
   */
  completeAgentDeliveryAttempt(
    attemptId: string,
    completion: AgentDeliveryAttemptCompletion
  ): AgentDeliveryAttempt | undefined {
    return this.#storage.transactionSync(() => {
      const [active] = this.#sql
        .exec<CycleStateRow & { attempt_number: number }>(
          `SELECT a.submission_id, a.attempt_number, s.retry_count,
                  s.cycle_started_at, s.cycle_attempt_base
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

      const errorDescription =
        "errorDescription" in completion &&
        completion.errorDescription !== undefined
          ? completion.errorDescription.slice(
              0,
              AGENT_DELIVERY_ERROR_DESCRIPTION_MAX_LENGTH
            )
          : null;
      this.#sql.exec(
        `UPDATE cf_channels_agent_delivery_attempts
         SET ended_at = ?, outcome = ?, error_description = ?
         WHERE attempt_id = ?`,
        new Date(this.#clock()).toISOString(),
        completion.outcome,
        errorDescription,
        attemptId
      );

      switch (completion.outcome) {
        case "acknowledged": {
          const transition = this.#sql.exec(
            `UPDATE cf_channels_submissions
             SET state = 'delivered', lease_expires_at = NULL
             WHERE submission_id = ? AND state = 'delivering'`,
            active.submission_id
          );
          if (transition.rowsWritten !== 1) {
            throw new Error(
              `Submission ${active.submission_id} lost ownership of attempt ${attemptId}`
            );
          }
          break;
        }
        case "permanent_error":
          this.#failSubmission(
            active.submission_id,
            "delivering",
            completion.errorDescription
          );
          break;
        default:
          this.#settleRetryableOutcome(active, describeRetryable(completion));
      }
      return this.getAgentDeliveryAttempt(attemptId);
    });
  }

  /**
   * Moves `delivering` submissions whose lease has expired back to a
   * scheduled retry, closing their abandoned attempts as `lease_expired`.
   * Returns the recovered submission IDs.
   */
  recoverExpiredLeases(limit = 100): string[] {
    return this.#storage.transactionSync(() => {
      const rows = this.#sql
        .exec<Record<string, SqlStorageValue> & { submission_id: string }>(
          `SELECT submission_id
           FROM cf_channels_submissions
           WHERE state = 'delivering' AND lease_expires_at <= ?
           ORDER BY lease_expires_at
           LIMIT ?`,
          new Date(this.#clock()).toISOString(),
          limit
        )
        .toArray();
      const recovered: string[] = [];
      for (const row of rows) {
        if (this.#recoverExpiredLease(row.submission_id)) {
          recovered.push(row.submission_id);
        }
      }
      return recovered;
    });
  }

  /**
   * Lists submissions whose scheduled attempt time has been reached, oldest
   * schedule first. Expired leases are not listed here; recover them with
   * {@link recoverExpiredLeases} so their retries are scheduled with backoff.
   */
  listDueSubmissions(limit = 50): string[] {
    return this.#sql
      .exec<Record<string, SqlStorageValue> & { submission_id: string }>(
        `SELECT submission_id
         FROM cf_channels_submissions
         WHERE state IN ('pending', 'retrying') AND next_attempt_at <= ?
         ORDER BY next_attempt_at
         LIMIT ?`,
        new Date(this.#clock()).toISOString(),
        limit
      )
      .toArray()
      .map((row) => row.submission_id);
  }

  /**
   * The earliest RFC 3339 time at which durable delivery work becomes
   * actionable: a scheduled attempt coming due or an active lease expiring.
   * Hosts persist this as their Durable Object alarm so retries survive
   * restarts and evictions without in-memory timers.
   */
  nextDeliveryEventAt(): string | undefined {
    const [row] = this.#sql
      .exec<Record<string, SqlStorageValue> & { next_event_at: string | null }>(
        `SELECT MIN(event_at) AS next_event_at FROM (
           SELECT next_attempt_at AS event_at
           FROM cf_channels_submissions
           WHERE state IN ('pending', 'retrying') AND next_attempt_at IS NOT NULL
           UNION ALL
           SELECT lease_expires_at
           FROM cf_channels_submissions
           WHERE state = 'delivering'
         )`
      )
      .toArray();
    return row?.next_event_at ?? undefined;
  }

  /**
   * Commits the intent to stop further delivery. An already escaped request
   * may still reach the agent; its late result becomes observational only.
   */
  cancel(submissionId: string): SubmissionCancellationResult {
    return this.#storage.transactionSync(() => {
      const transition = this.#sql.exec(
        `UPDATE cf_channels_submissions
         SET state = 'cancelled', lease_expires_at = NULL, next_attempt_at = NULL
         WHERE submission_id = ?
           AND state IN ('pending', 'retrying', 'delivering')`,
        submissionId
      );
      if (transition.rowsWritten === 1) {
        return { outcome: "cancelled" };
      }
      const [row] = this.#sql
        .exec<Record<string, SqlStorageValue> & { state: SubmissionState }>(
          `SELECT state FROM cf_channels_submissions WHERE submission_id = ?`,
          submissionId
        )
        .toArray();
      return row === undefined
        ? { outcome: "not_found" }
        : { outcome: "not_cancellable", state: row.state };
    });
  }

  /**
   * Starts a new audited delivery cycle for a terminally failed submission.
   *
   * The submission and turn IDs are retained, prior attempts and outcomes are
   * preserved, attempt numbering continues, and the retry budget and age
   * limit restart for the new cycle. The next attempt is due immediately.
   */
  replay(
    submissionId: string,
    request: { requestedBy: string }
  ): SubmissionReplayResult {
    return this.#storage.transactionSync(() => {
      const nowIso = new Date(this.#clock()).toISOString();
      const [{ attempt_count }] = this.#sql
        .exec<Record<string, SqlStorageValue> & { attempt_count: number }>(
          `SELECT COUNT(*) AS attempt_count
           FROM cf_channels_agent_delivery_attempts
           WHERE submission_id = ?`,
          submissionId
        )
        .toArray();
      const transition = this.#sql.exec(
        `UPDATE cf_channels_submissions
         SET state = 'retrying',
             retry_count = 0,
             next_attempt_at = ?,
             cycle_started_at = ?,
             cycle_attempt_base = ?,
             terminal_error = NULL
         WHERE submission_id = ? AND state = 'failed'`,
        nowIso,
        nowIso,
        attempt_count,
        submissionId
      );
      if (transition.rowsWritten !== 1) {
        const [row] = this.#sql
          .exec<Record<string, SqlStorageValue> & { state: SubmissionState }>(
            `SELECT state FROM cf_channels_submissions WHERE submission_id = ?`,
            submissionId
          )
          .toArray();
        return row === undefined
          ? { outcome: "not_found" }
          : { outcome: "not_replayable", state: row.state };
      }

      const replay: SubmissionReplay = {
        replayId: `replay_${crypto.randomUUID()}`,
        submissionId,
        requestedBy: request.requestedBy,
        requestedAt: nowIso
      };
      this.#sql.exec(
        `INSERT INTO cf_channels_submission_replays (
          replay_id, submission_id, requested_by, requested_at
        ) VALUES (?, ?, ?, ?)`,
        replay.replayId,
        replay.submissionId,
        replay.requestedBy,
        replay.requestedAt
      );
      return { outcome: "replayed", replay };
    });
  }

  listReplays(submissionId: string): SubmissionReplay[] {
    return this.#sql
      .exec<
        Record<string, SqlStorageValue> & {
          replay_id: string;
          submission_id: string;
          requested_by: string;
          requested_at: string;
        }
      >(
        `SELECT replay_id, submission_id, requested_by, requested_at
         FROM cf_channels_submission_replays
         WHERE submission_id = ?
         ORDER BY requested_at`,
        submissionId
      )
      .toArray()
      .map((row) => ({
        replayId: row.replay_id,
        submissionId: row.submission_id,
        requestedBy: row.requested_by,
        requestedAt: row.requested_at
      }));
  }

  getAgentDeliveryAttempt(attemptId: string): AgentDeliveryAttempt | undefined {
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

  /**
   * Recovers one `delivering` submission whose lease has expired: the
   * abandoned open attempt settles as `lease_expired` and the submission
   * moves to a scheduled retry (or terminal failure at a cycle limit).
   * Returns whether a recovery was applied.
   */
  #recoverExpiredLease(submissionId: string): boolean {
    const [row] = this.#sql
      .exec<CycleStateRow & { lease_expires_at: string }>(
        `SELECT submission_id, retry_count, cycle_started_at,
                cycle_attempt_base, lease_expires_at
         FROM cf_channels_submissions
         WHERE submission_id = ? AND state = 'delivering'`,
        submissionId
      )
      .toArray();
    if (row === undefined || Date.parse(row.lease_expires_at) > this.#clock()) {
      return false;
    }

    const [open] = this.#sql
      .exec<Record<string, SqlStorageValue> & { attempt_number: number }>(
        `SELECT attempt_number
         FROM cf_channels_agent_delivery_attempts
         WHERE submission_id = ? AND ended_at IS NULL`,
        submissionId
      )
      .toArray();
    this.#sql.exec(
      `UPDATE cf_channels_agent_delivery_attempts
       SET ended_at = ?, outcome = 'lease_expired',
           error_description = 'Lease expired before an attempt outcome was recorded'
       WHERE submission_id = ? AND ended_at IS NULL`,
      new Date(this.#clock()).toISOString(),
      submissionId
    );
    this.#settleRetryableOutcome(
      {
        submission_id: row.submission_id,
        retry_count: row.retry_count,
        cycle_started_at: row.cycle_started_at,
        cycle_attempt_base: row.cycle_attempt_base,
        attempt_number: open?.attempt_number ?? row.cycle_attempt_base
      },
      "Delivery lease expired before an attempt outcome was recorded"
    );
    return true;
  }

  /**
   * Applies the retryable-outcome transition for the active delivery: retry
   * with backoff, or terminal failure once a cycle limit is reached.
   */
  #settleRetryableOutcome(
    cycle: CycleStateRow & { attempt_number: number },
    description: string
  ): void {
    const now = this.#clock();
    const attemptsInCycle = cycle.attempt_number - cycle.cycle_attempt_base;
    if (attemptsInCycle >= this.#policy.maxAttemptsPerCycle) {
      this.#failSubmission(
        cycle.submission_id,
        "delivering",
        `Retry limit of ${this.#policy.maxAttemptsPerCycle} attempts reached; last outcome: ${description}`
      );
      return;
    }
    if (now - Date.parse(cycle.cycle_started_at) > this.#policy.maxCycleAgeMs) {
      this.#failSubmission(
        cycle.submission_id,
        "delivering",
        `Delivery age limit of ${this.#policy.maxCycleAgeMs}ms reached; last outcome: ${description}`
      );
      return;
    }

    const delay = retryDelayMs(this.#policy, cycle.retry_count, this.#random);
    const transition = this.#sql.exec(
      `UPDATE cf_channels_submissions
       SET state = 'retrying',
           retry_count = ?,
           next_attempt_at = ?,
           lease_expires_at = NULL
       WHERE submission_id = ? AND state = 'delivering'`,
      cycle.retry_count + 1,
      new Date(now + delay).toISOString(),
      cycle.submission_id
    );
    if (transition.rowsWritten !== 1) {
      throw new Error(
        `Submission ${cycle.submission_id} lost ownership while scheduling a retry`
      );
    }
  }

  #failSubmission(
    submissionId: string,
    fromState: SubmissionState,
    terminalError: string
  ): void {
    const transition = this.#sql.exec(
      `UPDATE cf_channels_submissions
       SET state = 'failed',
           lease_expires_at = NULL,
           next_attempt_at = NULL,
           terminal_error = ?
       WHERE submission_id = ? AND state = ?`,
      terminalError.slice(0, AGENT_DELIVERY_ERROR_DESCRIPTION_MAX_LENGTH),
      submissionId,
      fromState
    );
    if (transition.rowsWritten !== 1) {
      throw new Error(
        `Submission ${submissionId} lost ownership while recording terminal failure`
      );
    }
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
        created_at,
        state,
        next_attempt_at,
        cycle_started_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      envelope.submissionId,
      envelope.idempotencyKey,
      JSON.stringify(envelope),
      envelope.createdAt,
      envelope.createdAt,
      envelope.createdAt
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

function describeRetryable(
  completion: Extract<
    AgentDeliveryAttemptCompletion,
    { outcome: "unacknowledged" | "timeout" | "retryable_error" }
  >
): string {
  switch (completion.outcome) {
    case "timeout":
      return "Dispatch timed out";
    case "unacknowledged":
      return (
        completion.errorDescription ??
        "Dispatch returned without a turn-bound acknowledgement"
      );
    case "retryable_error":
      return completion.errorDescription;
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
