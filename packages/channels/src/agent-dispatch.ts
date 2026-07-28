import type { AgentDelivery } from "./agent-deliveries";
import type { SubmissionEnvelope } from "./submissions";

/** One request to deliver an accepted submission as its stable logical turn. */
export interface AgentTurnRequest {
  /** The immutable canonical submission accepted by Channels. */
  submission: SubmissionEnvelope;
  /** Channels-owned turn identity retained across every delivery attempt. */
  turnId: string;
}

/** Agent-facing boundary capable of receiving a logical turn. */
export interface AgentTurnReceiver {
  /** Send one turn to the selected agent. */
  receiveTurn(request: AgentTurnRequest): Promise<void>;
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
   * This transport boundary does not interpret a successful return as durable
   * agent acknowledgement or mutate submission state. Attempt recording,
   * acknowledgement, and state transitions are owned by later delivery
   * milestones.
   */
  async dispatch(
    submission: SubmissionEnvelope,
    delivery: AgentDelivery
  ): Promise<void> {
    if (delivery.submissionId !== submission.submissionId) {
      throw new Error(
        `Agent delivery for ${delivery.submissionId} cannot dispatch submission ${submission.submissionId}`
      );
    }

    const receiver = await this.#resolveTarget(submission.agentTarget);
    await receiver.receiveTurn({ submission, turnId: delivery.turnId });
  }
}
