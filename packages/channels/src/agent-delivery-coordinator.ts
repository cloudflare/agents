import {
  AGENT_DELIVERY_ERROR_DESCRIPTION_MAX_LENGTH,
  type AgentDeliveryAttempt,
  type AgentDeliveryAttemptCompletion
} from "./agent-delivery-attempts";
import { AgentDispatcher } from "./agent-dispatch";
import { SubmissionStore } from "./storage/submission-store";

/** Claims delivery work, dispatches it, and records the physical result. */
export class AgentDeliveryCoordinator {
  readonly #store: SubmissionStore;
  readonly #dispatcher: AgentDispatcher;

  constructor(store: SubmissionStore, dispatcher: AgentDispatcher) {
    this.#store = store;
    this.#dispatcher = dispatcher;
  }

  /**
   * Makes at most one physical request for an eligible submission.
   *
   * An undefined result means the submission does not exist or is not eligible
   * to begin an attempt. Dispatch errors are represented by the returned
   * attempt rather than thrown after their durable outcome has been recorded.
   */
  async dispatch(submissionId: string): Promise<AgentDeliveryAttempt | undefined> {
    const claimed = this.#store.beginAgentDeliveryAttempt(submissionId);
    if (claimed === undefined) {
      return undefined;
    }

    let completion: AgentDeliveryAttemptCompletion;
    try {
      await this.#dispatcher.dispatch(claimed.submission, claimed.delivery);
      completion = { outcome: "dispatch_returned" };
    } catch (error) {
      completion = {
        outcome: "dispatch_error",
        errorDescription: describeDispatchError(error)
      };
    }
    return this.#complete(claimed.attempt.attemptId, completion);
  }

  #complete(
    attemptId: string,
    completion: AgentDeliveryAttemptCompletion
  ): AgentDeliveryAttempt {
    const attempt = this.#store.completeAgentDeliveryAttempt(
      attemptId,
      completion
    );
    if (attempt === undefined) {
      throw new Error(`Agent delivery attempt ${attemptId} is no longer active`);
    }
    return attempt;
  }
}

function describeDispatchError(error: unknown): string {
  const description =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown agent dispatch error";
  return description.slice(0, AGENT_DELIVERY_ERROR_DESCRIPTION_MAX_LENGTH);
}
