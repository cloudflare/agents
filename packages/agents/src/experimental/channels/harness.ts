/**
 * Draft: the shared agent harness interface Channels serves conversations
 * from. Internal to `agents/experimental/channels` for now; it may move to
 * `agents/harnesses` once a harness implements it natively.
 *
 * Harness terms ("session", "operation", "run") are used here and in the
 * code that talks to a harness. Channels' own vocabulary stays as it is:
 * one Channels conversation is one harness session, with the same id, and
 * one Channels turn is one operation.
 *
 * Everything outbound names operations by the caller's operation id. The
 * user message an operation places is keyed by the caller's `messageId`, or
 * by the operation id when none is given. Model selection is absent on
 * purpose: it is the application's decision, not a client protocol.
 */
import type { Json, ResponseChunk, TranscriptMessage } from "./protocol";

export type SessionId = string;

/** One agent harness hosted in a Durable Object. */
export interface AgentHarness {
  readonly sessions: HarnessSessions;
  /** A handle on one session. Without an id, the harness's default session. */
  session(id?: SessionId): HarnessSession;
}

export interface HarnessSessions {
  create(): Promise<HarnessSession>;
  /** A new session that sees `from`'s history so far. */
  fork(from: SessionId): Promise<HarnessSession>;
  list(): Promise<SessionInfo[]>;
}

export type SessionInfo = {
  readonly id: SessionId;
  readonly parent?: SessionId;
  readonly busy: boolean;
};

export interface HarnessSession {
  readonly id: SessionId;
  /** A harness that takes no tool answers rejects them. */
  submit(
    input: (HarnessInput | ToolAnswer) & HarnessInputFrom,
    options?: SubmitOptions
  ): Promise<Receipt>;
  /** Stop one operation, or, without an id, everything in the session. */
  abort(operationId?: string): Promise<boolean>;
  wait(operationId: string, signal?: AbortSignal): Promise<OperationResult>;
  /** Start a new context, optionally from a handoff note. */
  reset(handoff?: string): Promise<void>;
  /** The current state, then every change, in order. */
  watch(): Promise<SessionWatch>;
}

export type InputPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file";
      readonly mediaType: string;
      readonly url: string;
      readonly filename?: string;
    };

export type HarnessInput = {
  readonly parts: readonly InputPart[];
  /**
   * The caller's id for the user message this places. Default: the
   * operation id.
   */
  readonly messageId?: string;
};

/**
 * Who sent an input, once a conversation has several participants. (From the
 * "later" draft, adopted early: a client tool's result is taken only from
 * the participant whose client runs it.)
 */
export type HarnessInputFrom = {
  readonly from?: { readonly participantId: string };
};

/**
 * A reply to something the agent asked for. Like a message, it makes the
 * agent act, so it is submitted, queued, deduplicated and settled as an
 * operation. (From the "later" draft, adopted early.)
 */
export type ToolAnswer =
  | {
      readonly type: "approval";
      readonly approvalId: string;
      readonly approved: boolean;
      readonly reason?: string;
    }
  | {
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly result:
        | { readonly ok: true; readonly output: Json }
        | { readonly ok: false; readonly errorText?: string };
    };

export type SubmitOptions = {
  /** Idempotency key. Submitting the same id twice returns the same receipt. */
  readonly operationId?: string;
  readonly whenBusy?: "followUp" | "steer";
};

export type Receipt = {
  readonly operationId: string;
  readonly session: SessionId;
  /** False when this operation id was already submitted. */
  readonly accepted: boolean;
};

export type OperationStatus =
  | { readonly operationId: string; readonly status: "queued" }
  | { readonly operationId: string; readonly status: "placed" }
  | {
      readonly operationId: string;
      readonly status: "done";
      readonly text?: string;
    }
  | {
      readonly operationId: string;
      readonly status: "unanswered";
      readonly reason?: string;
    };

export type OperationResult = Extract<
  OperationStatus,
  { status: "done" } | { status: "unanswered" }
> & { readonly session: SessionId };

export type SessionWatch = {
  readonly state: SessionState;
  start(listener: (events: readonly SessionEvent[]) => Promise<void>): void;
  stop(): Promise<void>;
  /** Settles when the watch ends, stopped or not. */
  readonly closed: Promise<void>;
};

/** Resume is from state: no event log, no cursors. */
export type SessionState = {
  /** The active transcript, since the newest reset. */
  readonly messages: readonly TranscriptMessage[];
  /** Operations not settled yet, oldest first. */
  readonly pending: readonly OperationStatus[];
  /** The run in progress, with its in-flight message. */
  readonly run?: {
    readonly operations: readonly string[];
    /**
     * The in-flight message so far, as chunks, with parts still streaming
     * left open. The watch's `chunk` events continue these parts. (The first
     * draft had a `TranscriptMessage` here, which later chunks could not
     * continue without showing the message twice.)
     */
    readonly partial?: readonly ResponseChunk[];
  };
};

export type SessionEvent =
  | { readonly type: "operation"; readonly status: OperationStatus }
  | { readonly type: "run-start"; readonly operations: readonly string[] }
  | { readonly type: "run-end"; readonly operations: readonly string[] }
  /** A streamed delta of the in-flight message. Part ids are unique per run. */
  | { readonly type: "chunk"; readonly chunk: ResponseChunk }
  /** A message saved to the transcript; replaces any message with its id. */
  | { readonly type: "message"; readonly message: TranscriptMessage }
  /**
   * The context was reset. Not in the first draft: without it a watcher
   * could not tell the active transcript restarted. Messages that follow
   * belong to the new context.
   */
  | { readonly type: "reset" };
