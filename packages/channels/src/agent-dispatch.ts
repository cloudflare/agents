import type { AgentDelivery } from "./agent-deliveries";
import type { SubmissionEnvelope } from "./submissions";

/** One request to deliver an accepted submission as its stable logical turn. */
export interface AgentTurnRequest {
  /** The immutable canonical submission accepted by Channels. */
  submission: SubmissionEnvelope;
  /** Channels-owned turn identity retained across every delivery attempt. */
  turnId: string;
}

/**
 * A positive, turn-bound acknowledgement that the agent has durably accepted
 * responsibility for the turn.
 *
 * Echoing the turn ID binds the acknowledgement to the delivered turn, so an
 * unrelated success response cannot be mistaken for delivery.
 *
 * @see {@link ../AGENT-DELIVERY-CONTRACT.md}
 */
export interface AgentTurnAcknowledgement {
  /** Must equal the turn ID of the delivered request. */
  turnId: string;
}

/** Agent-facing boundary capable of receiving a logical turn. */
export interface AgentTurnReceiver {
  /**
   * Receive one turn and acknowledge responsibility for it.
   *
   * Delivery is at least once: the same turn ID may arrive again if a prior
   * acknowledgement was lost, so receivers must deduplicate on the turn ID.
   * Throw a {@link PermanentDispatchError | permanently classified error} to
   * stop automatic retries; any other thrown error is retried.
   */
  receiveTurn(
    request: AgentTurnRequest
  ): AgentTurnAcknowledgement | Promise<AgentTurnAcknowledgement>;
}

/** Resolves an opaque submission target using host-application configuration. */
export type AgentTargetResolver = (
  agentTarget: string
) => AgentTurnReceiver | Promise<AgentTurnReceiver>;

/** Sends accepted submissions to host-resolved agent targets. */
export class AgentDispatcher {
  readonly #resolveTarget: AgentTargetResolver;

  constructor(resolveTarget: AgentTargetResolver) {
    this.#resolveTarget = resolveTarget;
  }

  /**
   * Sends the canonical envelope together with its stable turn ID.
   *
   * This transport boundary returns the receiver's raw acknowledgement without
   * validating or recording it. Attempt recording, acknowledgement validation,
   * and state transitions belong to the delivery coordinator and store.
   */
  async dispatch(
    submission: SubmissionEnvelope,
    delivery: AgentDelivery
  ): Promise<AgentTurnAcknowledgement> {
    if (delivery.submissionId !== submission.submissionId) {
      throw new Error(
        `Agent delivery for ${delivery.submissionId} cannot dispatch submission ${submission.submissionId}`
      );
    }

    const receiver = await this.#resolveTarget(submission.agentTarget);
    return receiver.receiveTurn({ submission, turnId: delivery.turnId });
  }
}
