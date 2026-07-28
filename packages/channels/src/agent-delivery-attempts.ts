import type { AgentDelivery } from "./agent-deliveries";
import type { SubmissionEnvelope } from "./submissions";

/** Maximum persisted length of an agent delivery error description. */
export const AGENT_DELIVERY_ERROR_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Classified result of one physical dispatch request.
 *
 * - `acknowledged`: the agent acknowledged responsibility for the turn, bound
 *   to the stable turn ID. The submission is delivered.
 * - `unacknowledged`: the dispatch returned without a valid turn-bound
 *   acknowledgement. Transport success is not delivery, so this retries.
 * - `timeout`: the dispatch did not settle within the configured timeout.
 *   Classified separately from explicit rejection; the request may still be
 *   running, so the agent may observe a duplicate turn. Retries.
 * - `retryable_error`: a transient failure such as a network error or an
 *   unclassified server error. Retries.
 * - `permanent_error`: malformed input, an authentication failure, or an
 *   explicit permanent agent rejection. Never retried automatically.
 * - `lease_expired`: no outcome was recorded before the attempt's lease
 *   expired (for example the runtime crashed mid-request). Written only by
 *   lease recovery, never by a dispatch worker. Retries.
 */
export type AgentDeliveryAttemptOutcome =
  | "acknowledged"
  | "unacknowledged"
  | "timeout"
  | "retryable_error"
  | "permanent_error"
  | "lease_expired";

/** One physical request made while delivering a stable logical turn. */
export interface AgentDeliveryAttempt {
  /** Channels-owned identity unique to this physical request. */
  attemptId: string;
  /** Submission whose logical turn this attempt delivers. */
  submissionId: string;
  /** Stable logical turn identity shared by every attempt. */
  turnId: string;
  /** One-based sequence number within the logical delivery. */
  attemptNumber: number;
  /** RFC 3339 time at which Channels claimed this attempt. */
  startedAt: string;
  /** RFC 3339 time at which the attempt settled. */
  endedAt?: string;
  /** Classified result, absent while the attempt is active. */
  outcome?: AgentDeliveryAttemptOutcome;
  /** Bounded description recorded for failed outcomes. */
  errorDescription?: string;
}

/** Durable records needed to make one claimed physical request. */
export interface ClaimedAgentDeliveryAttempt {
  /** The newly created active physical attempt. */
  attempt: AgentDeliveryAttempt;
  /** Immutable canonical input to send to the agent. */
  submission: SubmissionEnvelope;
  /** Logical delivery carrying the stable turn identity. */
  delivery: AgentDelivery;
}

/**
 * Result used by a dispatch worker to finish its active attempt.
 *
 * `lease_expired` is deliberately absent: only lease recovery may record it.
 */
export type AgentDeliveryAttemptCompletion =
  | { outcome: "acknowledged" }
  | { outcome: "unacknowledged"; errorDescription?: string }
  | { outcome: "timeout" }
  | { outcome: "retryable_error"; errorDescription: string }
  | { outcome: "permanent_error"; errorDescription: string };
