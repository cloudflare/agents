/**
 * `ThinkHarness`'s public types. Messages are AI SDK `UIMessage`s, as Think
 * stores them; the operation vocabulary is the shared harness interface's
 * (`agents/experimental/channels`), so a Channels host can serve a
 * ThinkHarness session directly.
 *
 * @experimental The API may change between releases.
 */
import type {
  JSONValue,
  LanguageModel,
  ModelMessage,
  ToolChoice,
  ToolSet,
  UIMessage,
  UIMessageChunk
} from "ai";
import type { ClientToolSchema } from "../../chat/client-tools";
import type {
  HarnessInput,
  OperationResult,
  Receipt,
  ToolAnswer
} from "../../experimental/channels/harness";
import type { Session } from "../../sessions/handle";

/**
 * A session id. The root session is `""`, the Sessions capability's default
 * session, which is where `@cloudflare/think` keeps its one conversation.
 *
 * @experimental
 */
export type ThinkSessionId = string;

/**
 * What a session accepts as input:
 *
 * - a string, as one user text message;
 * - one `UIMessage` or several, placed in order;
 * - the shared harness input (`{ parts }`);
 * - a tool result or an approval (`ToolAnswer`), which continues the turn
 *   that was waiting for it.
 *
 * @experimental
 */
export type ThinkInput =
  | string
  | UIMessage
  | readonly UIMessage[]
  | HarnessInput
  | ToolAnswer;

/**
 * What a submission does when the session is already running. Only
 * `followUp` (the default) is supported: the input is answered after the
 * current turn, as its own turn. Steering a running turn is not supported,
 * and a `"steer"` passed through the shared harness interface is refused
 * with `SteerNotSupportedError`.
 *
 * @experimental
 */
export type ThinkWhenBusy = "followUp";

/** Options for `submit()` and `prompt()`. @experimental */
export type ThinkSubmitOptions = {
  /** Idempotency key. Submitting the same id twice returns the same receipt. */
  readonly operationId?: string;
  readonly whenBusy?: ThinkWhenBusy;
  /**
   * Who wrote the input. `"client"` input is untrusted: the Sessions
   * capability strips its reserved metadata keys. Default `"server"`.
   */
  readonly source?: "client" | "server";
  /**
   * Tools the session's client runs, replacing any it declared before. They
   * are kept with the session, so later turns, including continuations
   * after an eviction, still offer them to the model.
   */
  readonly clientTools?: readonly ClientToolSchema[];
  /**
   * For a tool result or an approval: whether to continue the turn once
   * nothing else is awaited. Default `true`. With `false` the answer is
   * recorded and the turn waits for `session.continue()`.
   */
  readonly autoContinue?: boolean;
};

/** Returned once a submission is durable. @experimental */
export type ThinkReceipt = Receipt;

/** How one operation ended. @experimental */
export type ThinkOperationResult = OperationResult & {
  /** The assistant message the operation wrote, if it wrote one. */
  readonly messageId?: string;
};

/** A prompt's result, with the transcript after it. @experimental */
export type ThinkPromptResponse = ThinkOperationResult & {
  /** The session's active transcript. */
  readonly messages: readonly UIMessage[];
};

/** An operation not settled yet. @experimental */
export type ThinkPendingOperation = {
  readonly operationId: string;
  readonly session: ThinkSessionId;
  /** `queued` behind other work, or `running`. */
  readonly status: "queued" | "running";
};

/** The operation a session is running, mid model call. @experimental */
export type ThinkInFlight = {
  readonly operationId: string;
  /**
   * Whether the model call continues an assistant message already
   * persisted, so its chunks extend that message rather than start one.
   */
  readonly continuation: boolean;
  /** The call's chunks so far. */
  readonly chunks: readonly UIMessageChunk[];
};

/** An operation's status: open, or how it ended. @experimental */
export type ThinkOperationStatus =
  | {
      readonly operationId: string;
      readonly session: ThinkSessionId;
      readonly status: "queued" | "running";
    }
  | ThinkOperationResult;

/**
 * Receives one operation's answer as it streams, as Think's `chat()`
 * callback does.
 *
 * @experimental
 */
export type ThinkStreamCallback = {
  /** The submission is durable. */
  onStart?(event: { readonly operationId: string }): void | Promise<void>;
  /** One UI message chunk, as JSON. */
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  /** The operation ended unanswered, with the reason. */
  onError(error: string): void | Promise<void>;
};

/** A session the harness knows of. @experimental */
export type ThinkSessionInfo = {
  readonly id: ThinkSessionId;
  /** The session this one was forked from. */
  readonly parent?: ThinkSessionId;
  readonly busy: boolean;
};

/**
 * What the harness does with a tool call an eviction interrupted, set on
 * the tool as its `recovery` field.
 *
 * - `report` (default): record the call as failed with an "interrupted"
 *   error, so the model sees it and decides. Right for any tool whose
 *   effect may have happened.
 * - `rerun`: run it again. Only for tools that are safe to repeat.
 *
 * ```ts
 * tools: {
 *   search: { ...tool({ description, inputSchema, execute }), recovery: "rerun" }
 * }
 * ```
 *
 * @experimental
 */
export type ToolRecovery = "report" | "rerun";

/** The optional field a tool carries to set its recovery. @experimental */
export type RecoverableTool = { readonly recovery?: ToolRecovery };

/** Recovery policy. @experimental */
export type ThinkRecoveryOptions = {
  /**
   * Interruptions one operation survives without progress before it is
   * settled as `unanswered` with reason `"interrupted"`. A finished model
   * call or tool call is progress and resets the count. Default 10.
   */
  readonly maxAttempts?: number;
  /**
   * Delay before the second recovery attempt, doubled for each after it,
   * up to a minute. The first is immediate. Default 1000.
   */
  readonly backoffMs?: number;
  /**
   * A model stream that sends nothing for this long is treated as
   * interrupted and recovered. `0` turns the watchdog off. Default 120000.
   */
  readonly stallTimeoutMs?: number;
};

/** Context for every hook. @experimental */
export type ThinkHookContext = {
  readonly session: ThinkSessionId;
  readonly operationId: string;
};

/** Context for `beforeTurn`. @experimental */
export type ThinkTurnContext = ThinkHookContext & {
  /** Model calls this operation made before this one. */
  readonly step: number;
  /** Whether this call continues an assistant message already started. */
  readonly continuation: boolean;
  /** The transcript the model will see, with compaction applied. */
  readonly messages: readonly UIMessage[];
  /** The system prompt from the options, if any. */
  readonly system: string | undefined;
  /** Names of the tools on offer. */
  readonly tools: readonly string[];
};

/**
 * What `beforeTurn` may change for one model call. Unset fields keep the
 * harness's own values.
 *
 * @experimental
 */
export type ThinkTurnConfig = {
  readonly model?: LanguageModel;
  readonly system?: string;
  /** Replace the model messages the transcript converts to. */
  readonly messages?: ModelMessage[];
  /** Only offer these tools on this call. */
  readonly activeTools?: readonly string[];
  readonly toolChoice?: ToolChoice<ToolSet>;
  readonly providerOptions?: Record<string, Record<string, JSONValue>>;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
};

/** Context for `beforeToolCall`. @experimental */
export type ThinkToolCallContext = ThinkHookContext & {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  /** Runs of this call so far, counting this one. */
  readonly attempt: number;
};

/**
 * What `beforeToolCall` decides.
 *
 * - `{ action: "run" }` (or nothing): run the tool, with `input` replaced
 *   when given.
 * - `{ action: "block", reason }`: do not run it; the model sees the reason
 *   as the tool's error.
 * - `{ action: "substitute", output }`: do not run it; the model sees
 *   `output` as its result.
 *
 * @experimental
 */
export type ThinkToolCallDecision =
  | { readonly action: "run"; readonly input?: unknown }
  | { readonly action: "block"; readonly reason: string }
  | { readonly action: "substitute"; readonly output: unknown };

/** Context for `afterToolCall`. @experimental */
export type ThinkToolCallResultContext = ThinkToolCallContext &
  (
    | { readonly ok: true; readonly output: unknown }
    | { readonly ok: false; readonly errorText: string }
  );

/** Context for `onStepFinish`. @experimental */
export type ThinkStepFinishContext = ThinkHookContext & {
  readonly step: number;
  /** The assistant message as persisted after this model call. */
  readonly message: UIMessage;
  readonly finishReason: string | undefined;
};

/** Context for `onChunk`. @experimental */
export type ThinkChunkContext = ThinkHookContext & {
  readonly chunk: UIMessageChunk;
};

/** Context for `onTurnEnd`. @experimental */
export type ThinkTurnEndContext = ThinkOperationResult & {
  /** The assistant message the operation wrote, as persisted. */
  readonly message?: UIMessage;
};

/**
 * How the harness treats a model call's error.
 *
 * - `fail` (default): settle the operation `unanswered` with the error.
 * - `context-overflow`: compact the session, if it has a compaction
 *   function, and call the model again, once.
 * - `retry`: treat it like an interruption, within the recovery budget.
 *
 * @experimental
 */
export type ThinkErrorClass = "fail" | "context-overflow" | "retry";

/** Context for `onRecovery`. @experimental */
export type ThinkRecoveryContext = ThinkHookContext & {
  /** Interruptions without progress, counting this one. */
  readonly attempt: number;
  /** The partial assistant message rebuilt from the interrupted stream. */
  readonly partial: UIMessage | undefined;
};

/**
 * Hooks into the turn loop. All are optional, and each may be async. A
 * throwing hook ends the operation `unanswered`, except `onChunk`,
 * `onTurnEnd` and `onError`, whose errors are logged and ignored.
 *
 * @experimental
 */
export type ThinkHarnessHooks = {
  /**
   * Before every model call. A turn makes several, and after an eviction
   * the harness has no memory of what an earlier call returned, so it asks
   * again each time.
   */
  readonly beforeTurn?: (
    context: ThinkTurnContext
  ) => ThinkTurnConfig | void | Promise<ThinkTurnConfig | void>;
  /** Before each server tool call the harness runs. */
  readonly beforeToolCall?: (
    context: ThinkToolCallContext
  ) => ThinkToolCallDecision | void | Promise<ThinkToolCallDecision | void>;
  /** After each server tool call, with its result. */
  readonly afterToolCall?: (
    context: ThinkToolCallResultContext
  ) => void | Promise<void>;
  /** After each model call's message is persisted. */
  readonly onStepFinish?: (
    context: ThinkStepFinishContext
  ) => void | Promise<void>;
  /** For each UI chunk the model streams. */
  readonly onChunk?: (context: ThinkChunkContext) => void;
  /** After an operation settles. */
  readonly onTurnEnd?: (context: ThinkTurnEndContext) => void | Promise<void>;
  /** Observe a model call's error, before it is classified. */
  readonly onError?: (
    error: unknown,
    context: ThinkHookContext
  ) => void | Promise<void>;
  /** Classify a model call's error. Default: everything is `fail`. */
  readonly classifyError?: (error: unknown) => ThinkErrorClass;
  /**
   * Decide what to do with an interrupted model call. Default: `continue`
   * while within `recovery.maxAttempts`.
   */
  readonly onRecovery?: (
    context: ThinkRecoveryContext
  ) => "continue" | "abandon" | Promise<"continue" | "abandon">;
};

/** Context for options computed per session. @experimental */
export type ThinkSessionContext = {
  readonly session: ThinkSessionId;
};

/**
 * Something given directly or computed for each session.
 *
 * @experimental
 */
export type PerSession<T> =
  | T
  | ((context: ThinkSessionContext) => T | Promise<T>);

/** `ThinkHarness`'s options. @experimental */
export type ThinkHarnessOptions<TOOLS extends ToolSet = ToolSet> = {
  /**
   * Message-metadata keys only the server may write. The transcript strips
   * them from input submitted with `source: "client"`. Default: none.
   */
  readonly reservedMetadataKeys?: readonly string[];
  readonly model: PerSession<LanguageModel>;
  readonly system?: PerSession<string | undefined>;
  /**
   * Server tools, which the harness runs itself, one durable call at a
   * time, and tools without `execute`, which a client runs. A server tool
   * may carry `recovery: "rerun"` (see `ToolRecovery`).
   */
  readonly tools?: PerSession<TOOLS>;
  /** Most model calls one operation makes. Default 10. */
  readonly maxSteps?: number;
  /**
   * Whether a tool call needs approval before it runs. A tool's own
   * `needsApproval` is honored too.
   */
  readonly toolApproval?: (call: {
    readonly session: ThinkSessionId;
    readonly toolName: string;
    readonly toolCallId: string;
    readonly input: unknown;
  }) => boolean | Promise<boolean>;
  /** The budget for recovering interrupted work. */
  readonly recovery?: ThinkRecoveryOptions;
  /**
   * Configure a session's transcript handle the first time the harness
   * uses it, for example its compaction function and threshold.
   */
  readonly configureSession?: (session: Session, id: ThinkSessionId) => void;
  readonly hooks?: ThinkHarnessHooks;
};
