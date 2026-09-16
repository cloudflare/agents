/**
 * The developer API every harness exposes, and the runtime port a harness
 * implementation fills in. Type-only: importing this module pulls in no
 * runtime code, so a browser bundle and a container daemon can both use it.
 *
 * Vocabulary: a *session* is one conversation on a `Harness`; an *operation*
 * is one unit of work with a durable receipt (a prompt turn, a compaction);
 * a *request* is an open question from the agent (permission, question, host
 * tool); a *frame* is one durable event in a Streams log; a *preview* is a
 * live-only token delta that is never persisted.
 */
import type { SessionMessage, SessionMessagePart } from "agents/sessions";

/**
 * Plain JSON. Everything that crosses a boundary is this. Readonly arrays
 * and objects are accepted, and an object property may be `undefined`
 * (dropped by `JSON.stringify`), so example types written with `readonly`
 * and optional fields satisfy it without a mapped-type detour.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/**
 * A runtime declares its vocabulary once. The base stores it opaquely and
 * types it at the seam: runtime events ride `{ type: "extension", body }`,
 * runtime submissions ride `submit()`, and the runtime's terminal record is
 * `HarnessResult.raw`.
 */
export type HarnessProtocol = {
  /** Runtime-specific event bodies. Must carry a discriminant. */
  readonly event: { readonly type: string } & {
    readonly [key: string]: JsonValue;
  };
  /** Runtime-specific submissions beyond the reserved inbox kinds. */
  readonly submit: { readonly kind: string; readonly payload: JsonValue };
  /** The runtime's own terminal record. */
  readonly result: JsonValue;
};

/** The protocol of a runtime that declares nothing beyond the core. */
export type BaseProtocol = {
  readonly event: { readonly type: string } & {
    readonly [key: string]: JsonValue;
  };
  readonly submit: { readonly kind: string; readonly payload: JsonValue };
  readonly result: JsonValue;
};

/** The session id used when a call names none. */
export const DEFAULT_SESSION_ID = "main";

// ── Sessions ──────────────────────────────────────────────────────────────

export interface HarnessSessions<P extends HarnessProtocol = HarnessProtocol> {
  /**
   * Durably create a session. Idempotent on `sessionId`. Throws
   * `HarnessCapabilityUnsupportedError("sessions")` for a second id on a
   * single-session runtime.
   */
  create(options?: HarnessSessionCreateOptions): Promise<HarnessSession<P>>;
  /** A handle. Synchronous, no I/O. Default id is {@link DEFAULT_SESSION_ID}. */
  open(sessionId?: string): HarnessSession<P>;
  list(options?: HarnessSessionListOptions): Promise<HarnessSessionPage>;
  /** Destroy this session's durable state. Idempotent. */
  delete(sessionId: string): Promise<void>;
}

export interface HarnessSessionCreateOptions {
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  readonly title?: string;
  readonly config?: HarnessConfigPatch;
}

export interface HarnessSessionListOptions {
  readonly limit?: number;
  /** Opaque, from a previous page. */
  readonly cursor?: string;
  readonly order?: "asc" | "desc";
}

export interface HarnessSessionInfo {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly title?: string;
  readonly state: HarnessRunState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface HarnessSessionPage {
  readonly sessions: readonly HarnessSessionInfo[];
  readonly cursor?: string;
}

// ── The session handle ────────────────────────────────────────────────────

export interface HarnessSession<P extends HarnessProtocol = HarnessProtocol> {
  readonly sessionId: string;

  // drive
  /**
   * Admit one input. Resolves once the input and its wake are durable.
   * Never waits for the model.
   */
  prompt(
    input: HarnessInput,
    options?: HarnessPromptOptions
  ): Promise<HarnessReceipt>;
  /** Durably ask the active operation to stop. A no-op when idle. */
  interrupt(options?: HarnessInterruptOptions): Promise<HarnessInterruptResult>;

  // answer
  /** Every unanswered request from the agent. Empty for harnesses that never ask. */
  requests(): Promise<readonly HarnessRequest[]>;
  /** Answer one. A duplicate or late answer returns `accepted: false`. */
  reply(
    requestId: string,
    reply: HarnessReply
  ): Promise<{ readonly accepted: boolean }>;

  // read
  messages(options?: HarnessMessagesOptions): Promise<HarnessMessagePage>;
  status(): Promise<HarnessStatus>;
  result(operationId: string): Promise<HarnessResult<P> | undefined>;
  /**
   * Resolves with the terminal result whatever its status. Throws
   * `HarnessTimeoutError` or `HarnessOperationNotFoundError`. Pins the
   * Durable Object while waiting; durable callers use `events()`.
   */
  wait(
    operationId: string,
    options?: HarnessWaitOptions
  ): Promise<HarnessResult<P>>;
  /** Replay the durable log from `from`, then tail live. Ends when `signal` aborts. */
  events(
    options?: HarnessEventsOptions
  ): AsyncIterable<HarnessEvent<P> | HarnessPreview>;

  // lifetime
  /**
   * Release live resources (a remote runtime parks its container). Durable
   * state is untouched; the next `prompt()` re-attaches.
   */
  close(): Promise<void>;
  /** Destroy durable state for this session. Later calls on this handle throw `HarnessClosedError`. */
  delete(): Promise<void>;

  /** Escape hatch: a runtime-specific submission, typed by the protocol. */
  submit(
    submission: P["submit"],
    options?: HarnessSubmitOptions
  ): Promise<HarnessReceipt>;

  // Always present. Each throws HarnessCapabilityUnsupportedError unless
  // status().capabilities advertises it.
  compact(options?: HarnessCompactOptions): Promise<HarnessReceipt>; // "compact"
  fork(options?: HarnessForkOptions): Promise<HarnessSession<P>>; // "fork"
  rewind(
    toMessageId: string,
    options?: HarnessRewindOptions
  ): Promise<HarnessRewindResult>; // "rewind"
  configure(patch: HarnessConfigPatch): Promise<HarnessConfig>; // "configure"
  cancelQueued(operationId: string): Promise<boolean>; // "queue"
}

export type HarnessInput =
  | string
  | { readonly text?: string; readonly parts?: readonly SessionMessagePart[] };

export interface HarnessPromptOptions {
  /**
   * Idempotency key. Same id + same input + same delivery replays the
   * receipt with `accepted: false`; same id + different input throws
   * `HarnessConflictError`. Callers that need idempotency across retries
   * supply it; the default is minted inside the Durable Object.
   */
  readonly operationId?: string;
  /**
   * `"queue"` (default) runs when idle, behind anything queued. `"steer"`
   * folds into the running turn at its next boundary and requires the
   * `"steer"` capability.
   */
  readonly delivery?: "queue" | "steer";
  /** Cancels this call only, never the admitted operation. */
  readonly signal?: AbortSignal;
}

export interface HarnessSubmitOptions {
  readonly operationId?: string;
  readonly signal?: AbortSignal;
}

export interface HarnessReceipt {
  readonly operationId: string;
  readonly sessionId: string;
  readonly streamId: string;
  /** Opaque cursor positioned just before this operation's first frame. */
  readonly cursor: string;
  /** False when this operation id was already admitted or already settled. */
  readonly accepted: boolean;
  readonly state: "queued" | "running" | "settled";
  readonly delivery: "queue" | "steer";
}

export interface HarnessInterruptOptions {
  /** Default: the active operation. */
  readonly operationId?: string;
  readonly reason?: string;
  /** Also withdraw queued-but-unstarted operations. Default true. */
  readonly drain?: boolean;
  readonly signal?: AbortSignal;
}

export interface HarnessInterruptResult {
  readonly operationId: string | null;
  readonly newlyRequested: boolean;
  /** Queued operations withdrawn before they started (settled `declined`). */
  readonly drained: readonly {
    readonly operationId: string;
    readonly input: HarnessInput;
  }[];
}

// ── Requests ──────────────────────────────────────────────────────────────

interface HarnessRequestBase {
  readonly requestId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly createdAt: number;
  /** The base settles the request as timed out at this instant. */
  readonly expiresAt: number;
}

export type HarnessRequest =
  | (HarnessRequestBase & {
      readonly type: "permission";
      readonly toolCallId?: string;
      readonly action: string;
      readonly resources: readonly string[];
      readonly input?: JsonValue;
    })
  | (HarnessRequestBase & {
      readonly type: "question";
      readonly toolCallId?: string;
      readonly questions: readonly HarnessQuestion[];
    })
  | (HarnessRequestBase & {
      readonly type: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: JsonValue;
    })
  | (HarnessRequestBase & {
      readonly type: "extension";
      readonly kind: string;
      readonly payload: JsonValue;
    });

export interface HarnessQuestion {
  readonly header: string;
  readonly question: string;
  readonly options: readonly {
    readonly label: string;
    readonly description?: string;
  }[];
  readonly multiple?: boolean;
  readonly custom?: boolean;
}

export type HarnessReply =
  | {
      readonly type: "permission";
      readonly decision: "allow" | "allow_always" | "deny";
      readonly message?: string;
      readonly input?: JsonValue;
    }
  | {
      readonly type: "question";
      readonly answers: readonly (readonly string[])[] | null;
      readonly message?: string;
    }
  | {
      readonly type: "tool";
      readonly output: JsonValue;
      readonly isError?: boolean;
    }
  | {
      readonly type: "extension";
      readonly kind: string;
      readonly payload: JsonValue;
    };

/** A request as a runtime raises it: the base stamps `createdAt` and `expiresAt`. */
export type HarnessRequestDraft<T = HarnessRequest> = T extends unknown
  ? Omit<T, "createdAt" | "expiresAt" | "sessionId"> & {
      readonly expiresAt?: number;
    }
  : never;

// ── Status and results ────────────────────────────────────────────────────

/**
 * idle: nothing running. running: an operation is executing. blocked: at
 * least one request is open. retrying: the runtime is waiting out a
 * provider retry. terminated: the session was deleted, or its runtime was
 * lost and cannot resume.
 */
export type HarnessRunState =
  | "idle"
  | "running"
  | "blocked"
  | "retrying"
  | "terminated";

export interface HarnessStopReason {
  readonly type:
    | "end_turn"
    | "interrupted"
    | "declined"
    | "max_turns"
    | "max_tokens"
    | "budget"
    | "refusal"
    | "error"
    | "runtime_lost"
    | "other";
  /** The harness's own verbatim reason. */
  readonly raw?: string;
}

export interface HarnessUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** A client-side estimate, never billing data. */
  readonly costUsd?: number;
}

export interface HarnessStatus {
  readonly sessionId: string;
  readonly state: HarnessRunState;
  readonly operationId?: string;
  readonly stopReason?: HarnessStopReason;
  /** Open request ids. Non-empty implies `state === "blocked"`. */
  readonly pendingRequests: readonly string[];
  readonly queuedOperations: number;
  /** Head of the event log; a fresh client subscribes from here. */
  readonly cursor: string;
  /** The single answer a client renders feature gates from. */
  readonly capabilities: readonly HarnessCapability[];
  readonly usage?: HarnessUsage;
  readonly config?: HarnessConfig;
}

export interface HarnessResult<P extends HarnessProtocol = HarnessProtocol> {
  readonly operationId: string;
  readonly sessionId: string;
  /** declined: withdrawn before it started (an interrupt drain, or admission refused). */
  readonly status: "completed" | "aborted" | "failed" | "declined";
  readonly stopReason: HarnessStopReason;
  readonly streamId: string;
  readonly cursor: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly usage?: HarnessUsage;
  /** Engine-side queued input still pending after an interrupt. */
  readonly stillQueued?: readonly string[];
  readonly startedAt: number;
  readonly endedAt: number;
  /** The runtime's own terminal record. */
  readonly raw?: P["result"];
}

export interface HarnessWaitOptions {
  /** Default: none. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface HarnessMessagesOptions {
  /** Newest-first byte budget. Default 262_144. */
  readonly maxBytes?: number;
  /** Opaque anchor from a previous page. */
  readonly cursor?: string;
}

export interface HarnessMessagePage {
  /** `SessionMessage` from agents/sessions. There is no harness message type. */
  readonly messages: readonly SessionMessage[];
  readonly cursor?: string;
  /** The event-log position this page reflects; subscribe from here. */
  readonly asOf: string;
}

// ── Events ────────────────────────────────────────────────────────────────

export interface HarnessEventsOptions {
  /** Opaque token from a receipt, status, result, page or event. Omitted: the start of the log. */
  readonly from?: string;
  /** Also yield live previews (token deltas). Default false. */
  readonly previews?: boolean;
  readonly signal?: AbortSignal;
  /** Fires once when replay is drained and the reader is live. */
  readonly onUpToDate?: () => void;
}

/** What a frame in the log carries: a core event or a runtime extension. */
export type HarnessEventBody<P extends HarnessProtocol = HarnessProtocol> =
  | HarnessCoreEvent
  | { readonly type: "extension"; readonly body: P["event"] };

/** Stamped by a remote runtime: the daemon's wire seq and the generation that minted it. */
export type HarnessWireStamp = {
  readonly seq: number;
  readonly runtimeId: string;
};

export interface HarnessEvent<P extends HarnessProtocol = HarnessProtocol> {
  /** Session-monotonic, assigned by the base when the frame is appended. */
  readonly seq: number;
  readonly streamId: string;
  /** Opaque; pass back as `events({ from })`. */
  readonly cursor: string;
  readonly sessionId: string;
  readonly operationId?: string;
  readonly replay?: true;
  /** Present on frames a remote runtime ingested from a daemon. */
  readonly wire?: HarnessWireStamp;
  readonly body: HarnessEventBody<P>;
}

/** Live only. No seq, no cursor, never persisted, never replayed. */
export interface HarnessPreview {
  readonly preview: true;
  readonly sessionId: string;
  readonly operationId?: string;
  readonly body: HarnessPreviewBody;
}

export type HarnessPreviewBody =
  | {
      readonly type: "text_delta";
      readonly messageId: string;
      readonly delta: string;
    }
  | {
      readonly type: "reasoning_delta";
      readonly messageId: string;
      readonly delta: string;
    };

export type HarnessCoreEvent =
  | { readonly type: "session_opened"; readonly status: HarnessStatus }
  | { readonly type: "operation_started"; readonly delivery: "queue" | "steer" }
  | { readonly type: "operation_settled"; readonly result: HarnessResult }
  | {
      readonly type: "message_start";
      readonly messageId: string;
      readonly role: string;
    }
  | {
      /**
       * Parts use the AI SDK / Sessions shapes: `{ type: "text", text }`,
       * `{ type: "reasoning", text }`, `{ type: "tool-call", toolCallId,
       * toolName, input }`, `{ type: "tool-result", toolCallId, output }`.
       */
      readonly type: "message_end";
      readonly messageId: string;
      readonly role: string;
      readonly parts: readonly SessionMessagePart[];
    }
  | {
      readonly type: "tool_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "tool_end";
      readonly toolCallId: string;
      readonly output: JsonValue;
      readonly isError: boolean;
    }
  | { readonly type: "request_raised"; readonly request: HarnessRequest }
  | {
      readonly type: "request_replied";
      readonly requestId: string;
      readonly reply: HarnessReply;
      readonly by: "client" | "timeout" | "lost";
    }
  | { readonly type: "status"; readonly status: HarnessStatus }
  | { readonly type: "usage"; readonly usage: HarnessUsage }
  | {
      /** Frames between `from` and `to` were lost (a truncated remote outbox). */
      readonly type: "gap";
      readonly from: number;
      readonly to: number;
      readonly reason: string;
    }
  | {
      readonly type: "error";
      readonly error: { readonly code: string; readonly message: string };
    };

export type HarnessCapability =
  | "sessions"
  | "steer"
  | "queue"
  | "requests"
  | "compact"
  | "fork"
  | "rewind"
  | "configure"
  | "usage"
  | "workspace"
  | (string & {});

export interface HarnessConfig {
  readonly model?: string;
  readonly agent?: string;
  readonly permissionMode?:
    | "default"
    | "ask"
    | "accept_edits"
    | "plan"
    | "bypass";
  readonly tools?: { readonly [name: string]: boolean };
  readonly instructions?: string;
}
export type HarnessConfigPatch = Partial<HarnessConfig>;

export interface HarnessCompactOptions {
  readonly instructions?: string;
  readonly operationId?: string;
}
export interface HarnessForkOptions {
  readonly fromMessageId?: string;
  readonly sessionId?: string;
}
export interface HarnessRewindOptions {
  readonly files?: boolean;
  readonly dryRun?: boolean;
}
export interface HarnessRewindResult {
  readonly messageId: string;
  readonly removedMessageIds: readonly string[];
  readonly filesChanged?: readonly string[];
  readonly applied: boolean;
}

// ── Inbox vocabulary ──────────────────────────────────────────────────────

/** The reserved inbox kinds every runtime must honour, plus the runtime's own. */
export type HarnessInboxKind<P extends HarnessProtocol = HarnessProtocol> =
  | "prompt"
  | "interrupt"
  | "reply"
  | "compact"
  | P["submit"]["kind"];

export type HarnessInboxRow<P extends HarnessProtocol = HarnessProtocol> = {
  readonly seq: number;
  /** Dedupe key: the operation id for prompts, the request id for replies. */
  readonly key: string;
  readonly operationId: string | null;
  readonly kind: HarnessInboxKind<P>;
  readonly payload: JsonValue;
  readonly createdAt: number;
};

/** Payload of a `prompt` inbox row. */
export type HarnessPromptPayload = {
  readonly input: HarnessInput;
  readonly delivery: "queue" | "steer";
};
/** Payload of an `interrupt` inbox row. */
export type HarnessInterruptPayload = {
  readonly operationId: string;
  readonly reason?: string;
};
/** Payload of a `reply` inbox row. */
export type HarnessReplyPayload = {
  readonly requestId: string;
  readonly reply: HarnessReply;
  readonly by: "client" | "timeout" | "lost";
};
/** Payload of a `compact` inbox row. */
export type HarnessCompactPayload = HarnessCompactOptions;

/** What a runtime settles an operation with. */
export type HarnessSettlement<P extends HarnessProtocol = HarnessProtocol> = {
  readonly status: HarnessResult["status"];
  readonly stopReason: HarnessStopReason;
  readonly error?: HarnessResult["error"];
  readonly usage?: HarnessUsage;
  readonly stillQueued?: readonly string[];
  readonly raw?: P["result"];
};

// ── Errors ────────────────────────────────────────────────────────────────

export class HarnessError extends Error {
  readonly code: string = "E_HARNESS";
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
  toJSON(): JsonValue {
    return { name: this.name, code: this.code, message: this.message };
  }
}
export class HarnessCapabilityUnsupportedError extends HarnessError {
  override readonly code = "E_UNSUPPORTED";
  constructor(readonly capability: string) {
    super(`This harness does not support "${capability}"`);
  }
}
export class HarnessConflictError extends HarnessError {
  override readonly code = "E_CONFLICT";
  constructor(readonly operationId: string) {
    super(`Operation ${operationId} was already admitted with different input`);
  }
}
export class HarnessSessionNotFoundError extends HarnessError {
  override readonly code = "E_SESSION_NOT_FOUND";
  constructor(readonly sessionId: string) {
    super(`Unknown harness session ${JSON.stringify(sessionId)}`);
  }
}
export class HarnessOperationNotFoundError extends HarnessError {
  override readonly code = "E_OPERATION_NOT_FOUND";
  constructor(readonly operationId: string) {
    super(`Unknown operation ${operationId}`);
  }
}
export class HarnessRequestNotFoundError extends HarnessError {
  override readonly code = "E_REQUEST_NOT_FOUND";
  constructor(readonly requestId: string) {
    super(`Unknown or already answered request ${requestId}`);
  }
}
export class HarnessBackpressureError extends HarnessError {
  override readonly code = "E_BACKPRESSURE";
}
export class HarnessTimeoutError extends HarnessError {
  override readonly code = "E_TIMEOUT";
}
export class HarnessDetachedError extends HarnessError {
  override readonly code = "E_DETACHED";
}
export class HarnessClosedError extends HarnessError {
  override readonly code = "E_CLOSED";
}
