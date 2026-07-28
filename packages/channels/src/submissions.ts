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
export interface SubmissionAcceptance {
  /** Whether this call created the submission or found an existing one. */
  outcome: "accepted" | "duplicate";
  /** Channels-owned identity allocated by the first successful acceptance. */
  submissionId: string;
}

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
