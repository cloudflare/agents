/**
 * `PiHarness`'s public types. Kept separate from pi's own so callers depend
 * on a small, JSON-only surface: a pi release that reshapes an internal type
 * is absorbed in `messages.ts` and `pi-harness.ts`.
 */

/** Any JSON value. */
export type PiJson =
  | null
  | boolean
  | number
  | string
  | readonly PiJson[]
  | { readonly [key: string]: PiJson };

/** A pi conversation, addressed by its id as a string. The root is `"1"`. */
export type PiSessionId = string;

export type PiImage = {
  /** Base64-encoded bytes. */
  readonly data: string;
  readonly mimeType: string;
};

/** A prompt: plain text, or text with images. */
export type PiMessageInput =
  | string
  | { readonly text: string; readonly images?: readonly PiImage[] };

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
  readonly messages: readonly PiMessage[];
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

export type PiToolContent =
  | { readonly type: "text"; readonly text: string }
  | ({ readonly type: "image" } & PiImage);

export type PiMessagePart =
  | { readonly type: "text"; readonly text: string }
  | ({ readonly type: "image" } & PiImage)
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: PiJson;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly content: readonly PiToolContent[];
      readonly details?: PiJson;
      readonly error: boolean;
    };

/** One display-ready message projected from a pi transcript entry. */
export type PiMessage = {
  /** The pi entry id, or `live` for the message being streamed. */
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "notice";
  readonly parts: readonly PiMessagePart[];
  readonly timestamp: number;
  readonly stopReason?: string;
  readonly error?: string;
};
