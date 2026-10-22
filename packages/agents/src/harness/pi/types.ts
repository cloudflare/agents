import type { EntryRecord, InputEntry } from "@earendil-works/pi-durable";

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
 */
export type PiWhenBusy = "followUp" | "steer";

export type PiSubmitOptions = {
  /** Default: the root session. */
  readonly session?: PiSessionId;
  /** Idempotency key. Submitting the same id twice returns the same receipt. */
  readonly operationId?: string;
  readonly whenBusy?: PiWhenBusy;
  /**
   * The transcript entry the input is placed as, instead of pi's `pi.user`:
   * for input the user did not type, such as a scheduled prompt, a webhook,
   * or an approval's outcome. The model still gets the input as a user
   * message; `kind` and `data` record where it came from. The kind must not
   * start with `pi.`.
   */
  readonly entry?: InputEntry;
};

export type PiSessionOptions = {
  /** Default: the root session. */
  readonly session?: PiSessionId;
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
  /**
   * `queued` in pi's inbox, or `running` as part of the current run.
   * `parked`: running, but pi's crash-loop guard (`settings.restartLimit`)
   * stopped a task of the session; `retry()` runs it again.
   */
  readonly status: "queued" | "running" | "parked";
};

export type PiSessionInfo = {
  readonly id: PiSessionId;
  /** The session this one was forked from. */
  readonly parent?: PiSessionId;
  readonly busy: boolean;
};
