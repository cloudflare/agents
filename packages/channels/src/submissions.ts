import type { AgentDeliveryAttemptOutcome } from "./agent-delivery-attempts";

/** A value that can be represented without loss in durable JSON storage. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Minimal adapter-defined provenance for a submission. */
export interface SubmissionSource {
  /** The adapter-defined source category. */
  type: string;
  /** The source system's stable event or message identifier, when available. */
  id?: string;
}

/** Adapter-supplied immutable input for accepting a submission. */
export interface SubmissionInput {
  /** Adapter-owned identity used to deduplicate acceptance. */
  idempotencyKey: string;
  /** Stable name that the host application resolves to an agent. */
  agentTarget: string;
  /** Durable, JSON-compatible input for the agent. */
  payload: JsonValue;
  /** Minimal provenance for the external event. */
  source: SubmissionSource;
  /** Opaque input to later conversation resolution. */
  conversationHint?: string;
}

/**
 * The immutable durable representation of an accepted submission.
 *
 * @see {@link ../SUBMISSION-ENVELOPE.md}
 */
export interface SubmissionEnvelope extends SubmissionInput {
  /** Version of the persisted envelope shape. */
  schemaVersion: 1;
  /** Channels-owned identity of this submission. */
  submissionId: string;
  /** RFC 3339 time at which Channels accepted the submission. */
  createdAt: string;
}

/** Result of atomically accepting new or previously accepted input. */
export type SubmissionAcceptance =
  | {
      /** This call created a new durable submission. */
      outcome: "accepted";
      /** Channels-owned identity allocated by this acceptance. */
      submissionId: string;
    }
  | {
      /** Equivalent input was previously accepted under the same key. */
      outcome: "duplicate";
      /** Channels-owned identity allocated by the original acceptance. */
      submissionId: string;
    }
  | {
      /** The idempotency key is already bound to materially different input. */
      outcome: "conflict";
    };

/** Durable lifecycle state for delivery of a submission to its agent. */
export type SubmissionState =
  | "pending"
  | "delivering"
  | "retrying"
  | "delivered"
  | "failed"
  | "cancelled";

/** A submission envelope together with its mutable delivery state. */
export interface StoredSubmission {
  /** Immutable input accepted by Channels. */
  envelope: SubmissionEnvelope;
  /** Current durable delivery state. */
  state: SubmissionState;
}

/**
 * The operator-facing projection of a submission's delivery progress.
 *
 * It deliberately excludes the payload and conversation hint so status can be
 * inspected and returned over HTTP without exposing message content.
 */
export interface SubmissionStatus {
  /** Channels-owned identity of the submission. */
  submissionId: string;
  /** Stable logical turn identity shared by every delivery attempt. */
  turnId: string;
  /** Current durable delivery state. */
  state: SubmissionState;
  /** Stable name that the host application resolves to an agent. */
  agentTarget: string;
  /** Adapter-defined source category of the inbound event. */
  sourceType: string;
  /** RFC 3339 time at which Channels accepted the submission. */
  createdAt: string;
  /** Physical delivery attempts made so far, including the active one. */
  attemptCount: number;
  /** Retries scheduled in the current delivery cycle. */
  retryCount: number;
  /** Times the submission has been manually replayed after terminal failure. */
  replayCount: number;
  /** RFC 3339 time before which no further attempt starts, when scheduled. */
  nextAttemptAt?: string;
  /** RFC 3339 expiry of the active delivery lease, while `delivering`. */
  leaseExpiresAt?: string;
  /** Most recent attempt's classified outcome, once one has settled. */
  lastOutcome?: AgentDeliveryAttemptOutcome;
  /** RFC 3339 start time of the most recent attempt. */
  lastAttemptAt?: string;
  /** Bounded description of why automatic delivery stopped, when `failed`. */
  terminalError?: string;
}

/** One audited manual replay of a terminally failed submission. */
export interface SubmissionReplay {
  /** Channels-owned identity of this replay operation. */
  replayId: string;
  /** The replayed submission; its turn ID is retained. */
  submissionId: string;
  /** Operator or system identity that initiated the replay. */
  requestedBy: string;
  /** RFC 3339 time at which the replay was committed. */
  requestedAt: string;
}

/** Result of requesting a manual replay. */
export type SubmissionReplayResult =
  | { outcome: "replayed"; replay: SubmissionReplay }
  | { outcome: "not_found" }
  | {
      /** Only `failed` submissions can be replayed. */
      outcome: "not_replayable";
      state: SubmissionState;
    };

/** Result of requesting cancellation of further delivery. */
export type SubmissionCancellationResult =
  | { outcome: "cancelled" }
  | { outcome: "not_found" }
  | {
      /** The submission had already reached a terminal state. */
      outcome: "not_cancellable";
      state: SubmissionState;
    };
