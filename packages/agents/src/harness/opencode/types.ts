import type { OpenCodeWorkerd } from "@opencode/sdk/workerd";

/**
 * `OpenCodeHarness`'s own types: how the harness addresses sessions and
 * reports operations. They match `PiHarness`'s, field for field. Anything
 * OpenCode already publishes (prompt content, transcript messages, events)
 * is OpenCode's type, used directly.
 */

/** The OpenCode host the factory returns: `OpenCodeWorkerd.create`'s result. */
export type OpenCode = OpenCodeWorkerd.Interface;

type PromptRequest = Parameters<OpenCode["sessions"]["prompt"]>[0];

/**
 * What a prompt says: text, or text with OpenCode's attachments (files,
 * agent and skill mentions, metadata).
 */
export type OpenCodeInput =
  | string
  | Omit<PromptRequest, "sessionID" | "id" | "delivery" | "resume">;

/**
 * One message of an OpenCode transcript: user, assistant, idle markers,
 * compactions, and the rest of OpenCode's message kinds.
 */
export type OpenCodeMessage = Awaited<
  ReturnType<OpenCode["sessions"]["context"]>
>[number];

/** One of OpenCode's events: durable transcript events and live deltas. */
export type OpenCodeEvent =
  ReturnType<OpenCode["events"]["subscribe"]> extends AsyncIterable<infer E>
    ? E
    : never;

/**
 * One of a session's durable events, as `session.log()` replays them. Each
 * carries its sequence number in `durable.seq`.
 */
export type OpenCodeLogEvent =
  ReturnType<OpenCode["sessions"]["log"]> extends AsyncIterable<infer E>
    ? E
    : never;

/** An OpenCode session, addressed by its id. The root is `"ses_root"`. */
export type OpenCodeSessionId = string;

/**
 * What a submission does when the session is already running.
 *
 * - `followUp` (default): answered after the current run, as its own run.
 * - `steer`: joins the running work at its next step.
 */
export type OpenCodeWhenBusy = "followUp" | "steer";

/** Options for `submit` and `prompt`. */
export type OpenCodeSubmitOptions = {
  /** Default: the root session. */
  readonly session?: OpenCodeSessionId;
  /**
   * Idempotency key. Submitting the same id twice returns the same receipt.
   * Letters, digits, `.`, `_`, `~` and `-`; default a random UUID.
   */
  readonly operationId?: string;
  readonly whenBusy?: OpenCodeWhenBusy;
};

/** Selects a session. */
export type OpenCodeSessionOptions = {
  /** Default: the root session. */
  readonly session?: OpenCodeSessionId;
};

/** Returned once a submission is durable. It says nothing about the model yet. */
export type OpenCodeReceipt = {
  readonly operationId: string;
  readonly session: OpenCodeSessionId;
  /** False when this operation id was already submitted. */
  readonly accepted: boolean;
};

/** How one operation ended. */
export type OpenCodeOperationResult = {
  readonly operationId: string;
  readonly session: OpenCodeSessionId;
  /** `done`: answered. `unanswered`: failed, interrupted, or withdrawn. */
  readonly status: "done" | "unanswered";
  /**
   * Why an unanswered operation ended: `failed` (with OpenCode's error
   * message when it has one), `interrupted`, or `not_found`.
   */
  readonly reason?: string;
  /** The final assistant text, when answered. */
  readonly text?: string;
};

/** An operation's result and the session's transcript after it. */
export type OpenCodePromptResponse = OpenCodeOperationResult & {
  /** The session's active transcript after the operation. */
  readonly messages: readonly OpenCodeMessage[];
};

/** A submission OpenCode has not settled yet. */
export type OpenCodePendingOperation = {
  readonly operationId: string;
  readonly session: OpenCodeSessionId;
  /** `queued` in OpenCode's inbox, or `running` as part of the current run. */
  readonly status: "queued" | "running";
};

/** One session, as `sessions.list()` reports it. */
export type OpenCodeSessionInfo = {
  readonly id: OpenCodeSessionId;
  /** The session this one was forked from, or the one that spawned it. */
  readonly parent?: OpenCodeSessionId;
  readonly busy: boolean;
};
