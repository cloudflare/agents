/**
 * `OpenCodeHarness`'s own types: how the harness addresses sessions and
 * reports operations, in the same shape as `agents/harness/pi`. The
 * transcript and its events are projections of OpenCode's own records, so a
 * client does not need OpenCode's schema to render a turn.
 */

/** An OpenCode session, by its id. `ROOT_SESSION` names the object's root. */
export type OpenCodeSessionId = string;

/**
 * What a submission does when the session is already running.
 *
 * - `followUp` (default): answered after the current turn, as its own turn,
 *   with its own result. OpenCode calls this `queue`.
 * - `steer`: joins the running turn. OpenCode's own default.
 */
export type OpenCodeWhenBusy = "followUp" | "steer";

export type OpenCodeSubmitOptions = {
  /** Default: the root session. */
  readonly session?: OpenCodeSessionId;
  /** Idempotency key. Submitting the same id twice returns the same receipt. */
  readonly operationId?: string;
  readonly whenBusy?: OpenCodeWhenBusy;
  /** The OpenCode agent for this prompt. Default: the harness's. */
  readonly agent?: string;
};

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
  /** `done`: answered. `unanswered`: failed, aborted, or never admitted. */
  readonly status: "done" | "unanswered";
  /**
   * Why an unanswered operation ended: `aborted`, `not_admitted`,
   * `not_found`, or OpenCode's error type.
   */
  readonly reason?: string;
  /** The final assistant text, when answered. */
  readonly text?: string;
};

export type OpenCodePromptResponse = OpenCodeOperationResult & {
  /** The session's transcript after the operation. */
  readonly messages: readonly OpenCodeMessage[];
};

/** A submission OpenCode has not settled yet. */
export type OpenCodePendingOperation = {
  readonly operationId: string;
  readonly session: OpenCodeSessionId;
  /** `queued` in OpenCode's inbox, or `running` as the current turn. */
  readonly status: "queued" | "running";
};

export type OpenCodeSessionInfo = {
  readonly id: OpenCodeSessionId;
  /** The session this one was forked or spawned from. */
  readonly parent?: OpenCodeSessionId;
  readonly busy: boolean;
};

/**
 * A model, as OpenCode refers to one. `createAI` from
 * `agents/models/opencode` returns one from `ai(id)`.
 */
export type OpenCodeModel = {
  readonly providerID: string;
  readonly id: string;
};

/**
 * A provider: the entry under OpenCode's `providers` config that declares
 * it, and the plugin that serves it. `createAI` from
 * `agents/models/opencode` returns one as `ai.provider`.
 */
export type OpenCodeProvider = {
  readonly id: string;
  readonly config: Record<string, unknown>;
  readonly plugin: unknown;
};

// ── The transcript ────────────────────────────────────────────────────────

export type OpenCodeJson =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly OpenCodeJson[]
  | { readonly [key: string]: OpenCodeJson };

export type OpenCodePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly status: "pending" | "running" | "completed" | "error";
      readonly input?: OpenCodeJson;
      readonly output?: string;
      readonly error?: string;
    };

/** One OpenCode message, projected for display. */
export type OpenCodeMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly parts: readonly OpenCodePart[];
  readonly timestamp: number;
};

export type OpenCodePermission = {
  readonly id: string;
  readonly session: OpenCodeSessionId;
  readonly action: string;
  readonly resources: readonly string[];
  readonly askedAt: number;
};

// ── Events ────────────────────────────────────────────────────────────────

/**
 * OpenCode's live events for one session, projected. The first batch of a
 * watch starts with a `snapshot` that replaces the client's state.
 */
export type OpenCodeEvent =
  | ({ readonly type: "snapshot" } & OpenCodeSnapshot)
  | {
      readonly type: "operation_start";
      readonly operationId: string;
      readonly startedAt: number;
    }
  | {
      readonly type: "operation_end";
      readonly operationId: string;
      readonly status: "completed" | "aborted" | "failed" | "declined";
      readonly error?: { readonly code: string; readonly message: string };
      readonly endedAt: number;
    }
  | {
      readonly type: "operation_wait";
      readonly operationId: string;
      readonly reason: "permission" | "busy" | "budget";
      readonly notBefore: number;
    }
  | { readonly type: "message_start"; readonly message: OpenCodeMessage }
  | {
      readonly type: "text_delta";
      readonly messageId: string;
      readonly partId: string;
      readonly delta: string;
    }
  | {
      readonly type: "reasoning_delta";
      readonly messageId: string;
      readonly partId: string;
      readonly delta: string;
    }
  | {
      readonly type: "tool_start";
      readonly toolCallId: string;
      readonly name: string;
      readonly input: OpenCodeJson;
    }
  | {
      readonly type: "tool_end";
      readonly toolCallId: string;
      readonly name: string;
      readonly error: boolean;
      readonly output?: string;
    }
  | {
      readonly type: "permission_asked";
      readonly permission: OpenCodePermission;
    }
  | { readonly type: "permission_replied"; readonly permissionId: string }
  | { readonly type: "message_end"; readonly messageId: string }
  | { readonly type: "transcript_reset"; readonly reason: "compaction" }
  | { readonly type: "fault"; readonly code: string; readonly message: string };

/** A session as a client first sees it. */
export type OpenCodeSnapshot = {
  readonly session: OpenCodeSessionId;
  readonly messages: readonly OpenCodeMessage[];
  readonly running: boolean;
  /** The operation the session's events belong to, if one is open. */
  readonly operationId: string | null;
  readonly pending: readonly OpenCodePendingOperation[];
  readonly permissions: readonly OpenCodePermission[];
  readonly agent: string | null;
  readonly model: OpenCodeModel | null;
};

/**
 * One session's events: a snapshot, then a batch per event. Start it with a
 * listener; stop it when the client goes.
 */
export type OpenCodeEventStream = {
  readonly snapshot: OpenCodeEvent & { readonly type: "snapshot" };
  start(listener: (events: readonly OpenCodeEvent[]) => void): void;
  stop(): Promise<void>;
};
