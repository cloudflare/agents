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
  UIMessageChunk,
  LanguageModelUsage,
  streamText
} from "ai";
import type { ClientToolSchema } from "../../chat/client-tools";
import type {
  ChatRecoveryConfig,
  ChatRecoveryOptions
} from "../../chat/lifecycle";
import type {
  HarnessInput,
  HarnessInputFrom,
  OperationResult,
  Receipt,
  ToolAnswer
} from "../../experimental/channels/harness";
import type { Session } from "../../sessions/handle";
import type { Context } from "../../context/context";
import type { Tasks } from "../../tasks/tasks";
import type { TaskJson } from "../../tasks/types";
import type { ThinkExtension } from "./extensions/types";

/**
 * @internal An extension a host installs with the harness, by name.
 */
export type ThinkShippedExtension = {
  readonly name: string;
  readonly extension: ThinkExtension;
  /** Load it after the harness's own instead of ahead of them. */
  readonly after?: boolean;
};

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
 * The shared harness input and answers may name the participant they come
 * from (`from`); a turn's client tools belong to the participant who
 * started it.
 *
 * @experimental
 */
export type ThinkInput =
  | string
  | UIMessage
  | readonly UIMessage[]
  | (HarnessInput & HarnessInputFrom)
  | (ToolAnswer & HarnessInputFrom);

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
   * Who wrote the input. `"client"` input is untrusted: it may only add
   * `user` messages (an operation with any other role ends `unanswered`
   * with reason `"client_role"`), a message whose id is already stored is
   * dropped rather than rewritten, and reserved metadata keys are
   * stripped. Default `"server"`.
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
  /**
   * @internal A key that deduplicates repeated submissions onto one
   * operation, as Tasks' `idempotencyKey` does: the receipt names the
   * operation the first one started.
   */
  readonly idempotencyKey?: string;
  /**
   * @internal Submit it as a submission: listed and deleted with the
   * harness's `submissions` and `deleteSubmissions`, and kept across a
   * reset, as Think keeps its submissions.
   */
  readonly submission?: boolean;
  /** @internal JSON kept with the operation and returned by `inspect`. */
  readonly metadata?: Record<string, TaskJson>;
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

/**
 * A tool call of a session's latest reply that waits for a person's
 * decision. Answer it with an `approval` tool answer.
 *
 * @internal
 */
export type ThinkPendingApproval = {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
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
 * @internal An operation's status with what its run records: when it was
 * accepted, started and settled, and the key and metadata it was given.
 */
export type ThinkOperationInspection = ThinkOperationStatus & {
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, TaskJson>;
  /** The reason the caller that aborted the operation gave, if it gave one. */
  readonly abortReason?: string;
};

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
   * Interruptions one operation survives before it is settled as
   * `unanswered` with reason `"interrupted"`. Default 10.
   */
  readonly maxAttempts?: number;
  /**
   * A model stream that sends nothing for this long is treated as
   * interrupted and recovered. `0` turns the watchdog off. Default 120000.
   */
  readonly stallTimeoutMs?: number;
  /**
   * @internal The rest of a host's released `ChatRecoveryConfig` (the
   * harness-backed Think's `chatRecovery`), handed to the turn definition's
   * recovery budget as it is.
   */
  readonly chatRecovery?: Exclude<ChatRecoveryConfig, true>;
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
  /**
   * The system prompt: the `system` option followed by the session's
   * context prompt (see the `context` option), if either is set.
   */
  readonly system: string | undefined;
  /** Names of the tools on offer. */
  readonly tools: readonly string[];
  /**
   * @internal The tools on offer as built, for a host that hands them to
   * a hook of its own (the harness-backed Think's `beforeTurn`).
   */
  readonly toolSet: ToolSet;
  /**
   * @internal The operation's signal, which aborts when the operation is
   * stopped, for the same host (the harness-backed Think's `beforeTurn`
   * passes it on as `abortSignal`).
   */
  readonly signal: AbortSignal;
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
  /**
   * @internal The AI SDK's other call settings for this call, spread into
   * `streamText` before the harness's own arguments, so none of those can
   * be overridden here.
   */
  readonly callSettings?: ThinkCallSettings;
  /** @internal Whether reasoning reaches the stream; default true. */
  readonly sendReasoning?: boolean;
  /**
   * @internal Metadata for the reply from the model's stream parts, as
   * the AI SDK's `toUIMessageStream({ messageMetadata })` takes it. It is
   * merged onto the reply's metadata.
   */
  readonly messageMetadata?: (options: {
    readonly part: { readonly type: string };
  }) => Record<string, unknown> | undefined;
  /**
   * @internal The AI SDK's structured output spec (`Output.object(...)`),
   * passed to `streamText`. The last model call's parsed output is the
   * operation's `output`; one that does not parse fails the operation.
   */
  readonly output?: unknown;
};

/**
 * @internal `streamText`'s call settings a turn may set, beyond the ones
 * `ThinkTurnConfig` names.
 */
export type ThinkCallSettings = Pick<
  Parameters<typeof streamText>[0],
  | "topP"
  | "topK"
  | "presencePenalty"
  | "frequencyPenalty"
  | "stopSequences"
  | "seed"
  | "maxRetries"
  | "headers"
  | "experimental_transform"
  | "experimental_repairToolCall"
>;

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
  /** @internal The model call's token usage, when the provider gave it. */
  readonly usage?: LanguageModelUsage;
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
  /**
   * The turn's latest `stash()` data, or `null`.
   *
   * @internal For Think's `onChatRecovery`.
   */
  readonly recoveryData?: unknown;
};

/**
 * What `onRecovery` decides: `continue` or `abandon`. The object form is the
 * turn definition's own recovery options, for Think's `onChatRecovery`
 * (`persist: false` drops the partial).
 *
 * @experimental The object form is internal.
 */
export type ThinkRecoveryDecision =
  | "continue"
  | "abandon"
  | ChatRecoveryOptions;

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
  /**
   * @internal The reply as it is stored, for a host that keeps some of its
   * parts out of the transcript. A reply left with no parts is not stored.
   */
  readonly storedReply?: (message: UIMessage) => UIMessage;
  /**
   * @internal The turn's model loop ended with an answer. Throw to fail the
   * operation with the error's message instead.
   */
  readonly beforeTurnEnd?: (context: {
    readonly session: ThinkSessionId;
    readonly operationId: string;
    readonly message?: UIMessage;
  }) => void | Promise<void>;
  /**
   * @internal A model call overflowed the context window. Return whether
   * room was made, so the call is tried again; without this hook the
   * harness compacts the session and tries again.
   */
  readonly onContextOverflow?: (context: {
    readonly session: ThinkSessionId;
    readonly operationId: string;
  }) => Promise<boolean>;
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
  ) => ThinkRecoveryDecision | Promise<ThinkRecoveryDecision>;
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
   * Send older messages truncated, as Think's `truncationStep` does: the
   * cutoff moves by whole steps, so the prompt prefix is rewritten once per
   * step. Unset, nothing is truncated.
   *
   * @internal The harness-backed Think passes its `truncationStep`.
   */
  readonly truncationStep?: PerSession<number | undefined>;
  /**
   * Server tools, which the harness runs itself, one durable call at a
   * time, and tools without `execute`, which a client runs. A server tool
   * may carry `recovery: "rerun"` (see `ToolRecovery`).
   */
  readonly tools?: PerSession<TOOLS>;
  /**
   * Most model calls one operation makes. Default 10. As with the AI SDK's
   * `stepCountIs`, when the last allowed call asks for tools, the tools run
   * and the operation ends without another model reply.
   */
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
  /**
   * The context for a session, built on its handle the first time the
   * harness uses it. Its prompt follows `system`, its tools join `tools`,
   * and the harness records on each turn's user message the prompt and
   * changes that turn was sent with (see `Context` in `agents/context`).
   *
   * @experimental May change before stabilizing.
   */
  readonly context?: (
    session: Session,
    id: ThinkSessionId
  ) => Context | undefined;
  readonly hooks?: ThinkHarnessHooks;
  /**
   * @internal The Tasks capability the operations run on, installed by the
   * host before the harness. Default: the harness's own, which it installs
   * with itself. For a host whose rows are already in its default Tasks.
   */
  readonly tasks?: Tasks;
  /**
   * @internal Shipped extensions the host installs, in order, ahead of the
   * harness's own (the context's tools, then these options), or after them
   * when marked `after`. A later extension's tool of the same name replaces
   * an earlier one's in place.
   */
  readonly extensions?: readonly ThinkShippedExtension[];
  /**
   * @internal Told each time a submission (internal `submission` option)
   * is accepted, starts an attempt, or settles, as Tasks reports it: at
   * least once for the end, and before `wait()` resolves. A report a reset
   * cut short is made again, so `running` can come more often than there
   * were attempts; count attempts elsewhere. A throw is logged.
   */
  readonly onSubmissionStatus?: (
    status: ThinkOperationInspection
  ) => void | Promise<void>;
};
