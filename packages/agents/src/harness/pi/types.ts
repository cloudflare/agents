import type {
  AgentChange,
  ConversationInit,
  EntryRecord,
  InputEntry,
  SubmissionNotify
} from "@earendil-works/pi-durable";

/**
 * `PiHarness`'s own types: how the harness addresses sessions and reports
 * operations. Anything pi already publishes (input, transcript entries,
 * events) is pi's type, used directly.
 */

/** A pi conversation, addressed by its id as a string. The root is `"1"`. */
export type PiSessionId = string;

/**
 * What a submission does when the session is already running.
 *
 * - `followUp` (default): answered after the current run, as its own run.
 * - `steer`: joins the running work after the current tool round.
 * - `reject`: not admitted. `submit()` rejects with pi-durable's
 *   `ConversationBusy` and saves nothing, so the same `operationId` can be
 *   submitted again later. Use it to submit only if idle, atomically.
 */
export type PiWhenBusy = "followUp" | "steer" | "reject";

/**
 * What a submission does when the session is idle.
 *
 * - unset (default): starts a run.
 * - `reject`: not admitted. `submit()` rejects with pi-durable's
 *   `ConversationIdle` and saves nothing. With `whenBusy: "steer"`, the
 *   input joins the running work or is refused, in one step that cannot
 *   race the run's end.
 */
export type PiWhenIdle = "reject";

/**
 * What aborting the session does with a queued input:
 *
 * - `withdraw` (default): the input settles `unanswered` with reason
 *   `aborted`.
 * - `keep`: the input stays queued; the next input runs it first. For input
 *   its sender cannot send again, such as another agent's message.
 *   Withdrawing the operation itself (`abort(operationId)`) still removes it.
 */
export type PiOnAbort = "withdraw" | "keep";

export type PiSubmitOptions = {
  /** Default: the root session. */
  readonly session?: PiSessionId;
  /** Idempotency key. Submitting the same id twice returns the same receipt. */
  readonly operationId?: string;
  readonly whenBusy?: PiWhenBusy;
  readonly whenIdle?: PiWhenIdle;
  readonly onAbort?: PiOnAbort;
  /**
   * The transcript entry the input is placed as, instead of pi's `pi.user`:
   * for input the user did not type, such as a scheduled prompt, a webhook,
   * or an approval's outcome. The model still gets the input as a user
   * message; `kind` and `data` record where it came from. The kind must not
   * start with `pi.`.
   */
  readonly entry?: InputEntry;
  /**
   * A pi task to signal when this input settles: pi delivers its
   * `SubmissionSettled` signal, the settled record, to `taskId` under `key`.
   * For a tool that parks until another session answers. If the task has
   * ended or does not exist, the input settles as usual.
   */
  readonly notify?: SubmissionNotify;
};

export type PiContinueOptions = {
  /** Idempotency key. Continuing with the same id twice returns the same receipt. */
  readonly operationId?: string;
  /** A pi task to signal when the run settles. See `PiSubmitOptions.notify`. */
  readonly notify?: SubmissionNotify;
};

export type PiSessionOptions = {
  /** Default: the root session. */
  readonly session?: PiSessionId;
};

/**
 * How `harness.root()`, `sessions.create()` and `sessions.fork()` create a
 * session: pi-durable's `ConversationCreateOptions`, without `ownership`.
 * Both apply in the one commit that creates the session.
 */
export type PiSessionCreateOptions = {
  /**
   * pi's agent change for the new session. For the root and `create()`, it
   * is applied over the harness's `defaults`; a fork starts with its
   * parent's configuration, and this is applied over that.
   */
  readonly agent?: AgentChange;
  /**
   * pi's `ConversationInit`: runs inside the commit that creates the
   * session, after `agent`, for example to seed its transcript with
   * `tx.appendEntry()`, one entry per message. Table reads throw
   * `ReadAfterWrite` there. A throw fails the commit, so the session is not
   * created.
   */
  readonly init?: ConversationInit;
};

/** Returned once a submission is durable. It says nothing about the model yet. */
export type PiReceipt = {
  readonly operationId: string;
  readonly session: PiSessionId;
  /** False when this operation id was already submitted. */
  readonly accepted: boolean;
};

/** How one operation ended. */
export type PiOperationResult = {
  readonly operationId: string;
  readonly session: PiSessionId;
  /** `done`: answered. `unanswered`: failed, aborted, or withdrawn. */
  readonly status: "done" | "unanswered";
  /** Why an unanswered operation ended, in pi's words. */
  readonly reason?: string;
  /** The final assistant text, when answered. */
  readonly text?: string;
};

export type PiPromptResponse = PiOperationResult & {
  /** The session's active transcript after the operation. */
  readonly messages: readonly EntryRecord[];
};

/** A submission pi has not settled yet. */
export type PiPendingOperation = {
  readonly operationId: string;
  readonly session: PiSessionId;
  /** `queued` in pi's inbox, or `running` as part of the current run. */
  readonly status: "queued" | "running";
};

export type PiSessionInfo = {
  readonly id: PiSessionId;
  /** The session this one was forked from. */
  readonly parent?: PiSessionId;
  readonly busy: boolean;
};
