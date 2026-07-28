import type { AgentDelivery } from "./agent-deliveries";
import type { SubmissionEnvelope } from "./submissions";

/** Maximum persisted length of an agent delivery error description. */
export const AGENT_DELIVERY_ERROR_DESCRIPTION_MAX_LENGTH = 1024;

/** Observable result of invoking the current agent dispatch boundary. */
export type AgentDeliveryAttemptOutcome =
  | "dispatch_returned"
  | "dispatch_error";

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
  /** RFC 3339 time at which the dispatch invocation settled. */
  endedAt?: string;
  /** Dispatch-boundary result, absent while the attempt is active. */
  outcome?: AgentDeliveryAttemptOutcome;
  /** Bounded description recorded when the dispatch throws. */
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

/** Result used to finish an active agent delivery attempt. */
export type AgentDeliveryAttemptCompletion =
  | { outcome: "dispatch_returned" }
  | { outcome: "dispatch_error"; errorDescription: string };
