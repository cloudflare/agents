/**
 * One durable promise to deliver an accepted submission as a logical turn.
 * Creating this identity does not mean physical delivery has started. Delivery
 * state remains the submission status projection rather than being duplicated
 * here.
 *
 * The turn ID identifies the logical delivery, so there is no separate logical
 * delivery ID. Automatic retries and manual replay retain it; each physical
 * request receives its own attempt ID in a later milestone.
 */
export interface AgentDelivery {
  /** The accepted submission that created this logical delivery. */
  submissionId: string;
  /** Channels-owned identity retained across retries and manual replay. */
  turnId: string;
}
