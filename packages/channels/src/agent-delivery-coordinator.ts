import {
  AGENT_DELIVERY_ERROR_DESCRIPTION_MAX_LENGTH,
  type AgentDeliveryAttempt,
  type AgentDeliveryAttemptCompletion
} from "./agent-delivery-attempts";
import type {
  AgentDispatcher,
  AgentTurnAcknowledgement
} from "./agent-dispatch";
import {
  type DispatchErrorClassifier,
  classifyDispatchError
} from "./retry-classification";
import type { SubmissionStore } from "./storage/submission-store";

/** Request-side behavior of one dispatch invocation. */
export interface AgentDeliveryCoordinatorOptions {
  /**
   * Time allowed for one dispatch invocation to settle before its attempt is
   * classified as `timeout` and its claim is released. A timed-out request
   * may still be running; a late result cannot mutate submission state.
   */
  dispatchTimeoutMs?: number;
  /** Decides whether a thrown dispatch error may be retried. */
  classifyError?: DispatchErrorClassifier;
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

class DispatchTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`Agent dispatch did not settle within ${timeoutMs}ms`);
    this.name = "DispatchTimeout";
  }
}

/** Claims delivery work, dispatches it, and records the classified result. */
export class AgentDeliveryCoordinator {
  readonly #store: SubmissionStore;
  readonly #dispatcher: AgentDispatcher;
  readonly #dispatchTimeoutMs: number;
  readonly #classifyError: DispatchErrorClassifier;

  constructor(
    store: SubmissionStore,
    dispatcher: AgentDispatcher,
    options: AgentDeliveryCoordinatorOptions = {}
  ) {
    this.#store = store;
    this.#dispatcher = dispatcher;
    this.#dispatchTimeoutMs =
      options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    this.#classifyError = options.classifyError ?? classifyDispatchError;
  }

  /**
   * Makes at most one physical request for an eligible submission.
   *
   * An undefined result means the submission does not exist or is not
   * eligible to begin an attempt. Dispatch failures are represented by the
   * returned attempt rather than thrown after their durable outcome has been
   * recorded. The returned attempt reflects this invocation even when a
   * stale completion could no longer mutate submission state.
   */
  async dispatch(
    submissionId: string
  ): Promise<AgentDeliveryAttempt | undefined> {
    const claimed = this.#store.beginAgentDeliveryAttempt(submissionId);
    if (claimed === undefined) {
      return undefined;
    }

    let completion: AgentDeliveryAttemptCompletion;
    try {
      const acknowledgement = await this.#withTimeout(
        Promise.resolve(
          this.#dispatcher.dispatch(claimed.submission, claimed.delivery)
        )
      );
      completion =
        acknowledgement?.turnId === claimed.delivery.turnId
          ? { outcome: "acknowledged" }
          : {
              outcome: "unacknowledged",
              errorDescription: `Dispatch returned without acknowledging turn ${claimed.delivery.turnId}`
            };
    } catch (error) {
      completion =
        error instanceof DispatchTimeout
          ? { outcome: "timeout" }
          : this.#classifyError(error) === "permanent"
            ? {
                outcome: "permanent_error",
                errorDescription: describeDispatchError(error)
              }
            : {
                outcome: "retryable_error",
                errorDescription: describeDispatchError(error)
              };
    }

    // A stale completion (for example after lease recovery) records nothing;
    // the attempt row still describes what this invocation observed.
    return (
      this.#store.completeAgentDeliveryAttempt(
        claimed.attempt.attemptId,
        completion
      ) ?? this.#store.getAgentDeliveryAttempt(claimed.attempt.attemptId)
    );
  }

  async #withTimeout(
    work: Promise<AgentTurnAcknowledgement>
  ): Promise<AgentTurnAcknowledgement> {
    if (!Number.isFinite(this.#dispatchTimeoutMs)) {
      return work;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new DispatchTimeout(this.#dispatchTimeoutMs)),
        this.#dispatchTimeoutMs
      );
    });
    try {
      return await Promise.race([work, expiry]);
    } finally {
      clearTimeout(timer);
      // A timed-out request may settle later; keep its rejection observed.
      work.catch(() => {});
    }
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
