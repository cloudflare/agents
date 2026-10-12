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

/**
 * One of OpenCode's own events: durable transcript events and live deltas.
 * `session.events()` translates these into `OpenCodeSessionEvent`s.
 */
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
  /** The title OpenCode generated for the session, once it has one. */
  readonly title?: string;
  /** Running, input waiting, or a turn a restart cut off, about to resume. */
  readonly busy: boolean;
};

/** A permission OpenCode asked for, waiting on a reply. */
export type OpenCodePermission = {
  readonly id: string;
  readonly session: OpenCodeSessionId;
  /** What OpenCode wants to do, such as `edit` or `webfetch`. */
  readonly action: string;
  /** What the action applies to, such as paths or URLs. */
  readonly resources: readonly string[];
  readonly message?: string;
};

/** How an assistant message's step ended, as OpenCode reports it. */
export type OpenCodeFinish =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "unknown";

/**
 * One event on a session's stream, translated from OpenCode's events into
 * the same kinds of event `PiHarness` and `ContainerHarness` report.
 * `messageId` is OpenCode's assistant message id. Text and reasoning are
 * addressed by `ordinal`, their position among the message's parts of the
 * same kind.
 */
export type OpenCodeSessionEvent =
  /**
   * An input is in OpenCode's inbox. Every input goes through it, so this
   * comes before `operation_start` even when the session is idle.
   */
  | { readonly type: "operation_queued"; readonly operationId: string }
  /** A queued input was withdrawn before it ran. */
  | { readonly type: "operation_withdrawn"; readonly operationId: string }
  /** An input joined the transcript; the next assistant message answers it. */
  | { readonly type: "operation_start"; readonly operationId: string }
  /** An input has its answer: the same result `wait()` returns. */
  | {
      readonly type: "operation_end";
      readonly result: OpenCodeOperationResult;
    }
  /** OpenCode started a run. One run answers every input it drains. */
  | { readonly type: "run_start" }
  | {
      readonly type: "run_end";
      readonly outcome: "succeeded" | "failed" | "interrupted";
      readonly error?: string;
    }
  | {
      readonly type: "message_start";
      readonly messageId: string;
      readonly agent: string;
      readonly model: { readonly providerID: string; readonly id: string };
    }
  | {
      readonly type: "text_delta";
      readonly messageId: string;
      readonly ordinal: number;
      readonly delta: string;
    }
  /** A text part is complete; `text` is the whole part. */
  | {
      readonly type: "text_end";
      readonly messageId: string;
      readonly ordinal: number;
      readonly text: string;
    }
  | {
      readonly type: "reasoning_delta";
      readonly messageId: string;
      readonly ordinal: number;
      readonly delta: string;
    }
  | {
      readonly type: "reasoning_end";
      readonly messageId: string;
      readonly ordinal: number;
      readonly text: string;
    }
  /** The model called a tool and OpenCode has its whole input. */
  | {
      readonly type: "tool_start";
      readonly messageId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "tool_end";
      readonly messageId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly error: boolean;
      /** The tool's text output, or its error message. */
      readonly output: string;
    }
  | {
      readonly type: "message_end";
      readonly messageId: string;
      readonly finish: OpenCodeFinish;
      readonly error?: string;
    }
  /** A model call failed and OpenCode will try again at `at`. */
  | {
      readonly type: "retry_scheduled";
      readonly messageId: string;
      readonly attempt: number;
      readonly at: number;
      readonly error: string;
    }
  | {
      readonly type: "compaction_start";
      readonly reason: "auto" | "manual";
    }
  /**
   * OpenCode compacted the session: `messages()` is now shorter, and
   * `history()` has a compaction message. Read the transcript again.
   */
  | { readonly type: "transcript_reset"; readonly reason: "compaction" }
  | {
      readonly type: "permission_asked";
      readonly permission: OpenCodePermission;
    }
  | {
      readonly type: "permission_replied";
      readonly permissionId: string;
      readonly reply: "once" | "always" | "reject";
    }
  /**
   * Something went wrong outside a model step: `compaction_failed`, or
   * `events_failed` when OpenCode's event stream ended with an error. No
   * more events follow `events_failed`; open a new stream.
   */
  | {
      readonly type: "fault";
      readonly code: "compaction_failed" | "events_failed";
      readonly message: string;
    };

/** A session's state when its event stream opens. */
export type OpenCodeSessionSnapshot = {
  readonly session: OpenCodeSessionId;
  /** The whole transcript, compacted messages included: `history()`. */
  readonly messages: readonly OpenCodeMessage[];
  readonly pending: readonly OpenCodePendingOperation[];
  readonly busy: boolean;
  /** Permissions OpenCode is waiting on. */
  readonly permissions: readonly OpenCodePermission[];
};

/**
 * A session's events: the snapshot taken when the stream opened, then every
 * event after it, in batches, including any that arrived before `start()`.
 * An event may repeat what the snapshot already shows; messages are keyed
 * by id. Live: events reach listeners in the isolate that runs the harness,
 * and the stream holds OpenCode open until `stop()`. Call `stop()` when
 * done, started or not.
 */
export type OpenCodeEventStream = {
  readonly snapshot: OpenCodeSessionSnapshot;
  /** Start delivering events. Call once. */
  start(listener: (events: readonly OpenCodeSessionEvent[]) => void): void;
  /** Stop delivering events and release OpenCode. */
  stop(): Promise<void>;
};
