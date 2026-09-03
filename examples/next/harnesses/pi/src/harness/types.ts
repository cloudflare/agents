import type { Static, TSchema } from "typebox";
import type { SkillSource } from "agents/skills";
import type { Streams } from "agents/streams";
import type { Tasks } from "agents/tasks";

/** Invocation-scoped cancellation and application values used by pi callbacks. */
export interface PiContext {
  /** Cancels this invocation without durably aborting its operation. */
  readonly abortSignal: AbortSignal | undefined;
  /** Read an invocation-scoped value. */
  value<Value>(key: PiContextKey<Value>): Value | undefined;
  /** Render a diagnostic name for this context chain. */
  toString(): string;
}

/** Typed key for values carried by a {@link PiContext}. */
export interface PiContextKey<Value> {
  readonly token: symbol;
  /** Type-only marker preventing keys for different values interchanging. */
  readonly valueType?: (value: Value) => Value;
}

/** Minimum model identity required by the harness. */
export type PiModel = {
  readonly id: string;
  readonly provider: string;
  readonly api: string;
} & object;

/**
 * Pi's provider registry. The concrete object normally comes from pi-ai's
 * `createModels()` or another implementation of the same runtime contract.
 */
export type PiModels = object;

/** Provider and model id pair identifying a lane's configured model. */
export type PiModelIdentity = {
  readonly provider: string;
  readonly modelId: string;
};

/** Reasoning effort requested from models that support it. */
export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** JSON value carried by projected messages, events, and tool results. */
export type PiJson =
  | string
  | number
  | boolean
  | null
  | undefined
  | PiJson[]
  | { [key: string]: PiJson };

/** Base64 image content accepted in prompts and returned by tools. */
export type PiImage = {
  readonly data: string;
  readonly mimeType: string;
};

/** Text or image content returned by a pi tool. */
export type PiToolContent =
  | { readonly type: "text"; readonly text: string }
  | ({ readonly type: "image" } & PiImage);

/** Usage attributed to a model or tool operation. */
export type PiUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h?: number;
  readonly reasoning?: number;
  readonly totalTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
};

/** Complete or partial result produced by a pi tool. */
export type PiToolResult<Details = PiJson> = {
  readonly content: readonly PiToolContent[];
  readonly details: Details;
  readonly usage?: PiUsage;
  readonly addedToolNames?: readonly string[];
  readonly terminate?: boolean;
};

/** Options for one live tool progress update. */
export type PiToolUpdateOptions = {
  /** Persist this bounded snapshot for crash recovery. */
  readonly checkpoint?: true;
};

/** Live progress callback supplied to a pi tool. */
export type PiToolUpdate<Details> = (
  partial: PiToolResult<Details>,
  options?: PiToolUpdateOptions
) => void;

/** Stable identity and durable memo access for one logical tool call. */
export interface PiToolInvocation {
  readonly invocationId: string;
  readonly operationId: string;
  readonly turnId: string;
  /** Read one invocation-scoped replay memo. */
  getMemo(name: string): Promise<unknown>;
  /** Set or delete one invocation-scoped replay memo. */
  setMemo(name: string, value: unknown | undefined): Promise<void>;
}

/** Tool definition executed by {@link PiHarness}. */
export type PiTool<
  ToolContext extends object | undefined = object | undefined,
  Parameters extends TSchema = TSchema,
  Details = PiJson
> = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Parameters;
  /**
   * Recovery policy when the call's durable intent exists but its outcome is
   * unknown after a crash. `"safe"` re-executes; `"never"` (the default)
   * settles the call as interrupted.
   */
  readonly replay?: "never" | "safe";
  readonly executionMode?: "sequential" | "parallel";
  readonly prepareArguments?: (arguments_: unknown) => Static<Parameters>;
  execute(
    toolCallId: string,
    parameters: Static<Parameters>,
    onUpdate: PiToolUpdate<Details>,
    toolContext: ToolContext,
    invocation: PiToolInvocation,
    context: PiContext
  ): Promise<PiToolResult<Details>>;
};

/** Static tools or a hook that resolves current definitions before each pass. */
export type PiToolSource<
  ToolContext extends object | undefined = object | undefined
> =
  | readonly PiTool<ToolContext>[]
  | ((
      context: PiContext
    ) =>
      | readonly PiTool<ToolContext>[]
      | Promise<readonly PiTool<ToolContext>[]>);

/** Process-local pi hook registry rebuilt after every Durable Object wake. */
export interface PiHookRegistry {
  /** Register one upstream pi interception hook. */
  on(
    name:
      | "before_run"
      | "before_drive"
      | "before_run_end"
      | "transform_context"
      | "before_request"
      | "before_payload"
      | "after_response"
      | "before_tool"
      | "after_tool"
      | "before_compaction"
      | "before_navigation",
    handler: (event: unknown, context: PiContext) => unknown | Promise<unknown>,
    options?: { readonly id?: string }
  ): () => void;
}

/** Curated provider request settings owned by the harness. */
export type PiStreamOptions = {
  readonly transport?: "sse" | "websocket" | "websocket-cached" | "auto";
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly maxRetryDelayMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly cacheRetention?: "none" | "short" | "long";
  readonly deferred?: boolean | { readonly window?: "15m" | "1h" | "24h" };
};

/** Retry policy captured into an accepted pi operation. */
export type PiRetryPolicy = {
  readonly enabled: boolean;
  readonly maxRetries: number;
  readonly baseDelayMs: number;
};

/** Compaction policy captured into an accepted pi operation. */
export type PiCompactionSettings = {
  readonly enabled: boolean;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
};

// ── Execution environment ─────────────────────────────────────────────────

/** Outcome of a fallible execution-environment call; failures are values. */
export type PiResult<Value, Failure> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure };

/** Kind of filesystem object. Symlinks are never followed implicitly. */
export type PiFileKind = "file" | "directory" | "symlink";

/** Backend-independent file failure codes. */
export type PiFileErrorCode =
  | "aborted"
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "not_supported"
  | "unknown";

/** Backend-independent shell failure codes. */
export type PiExecutionErrorCode =
  | "aborted"
  | "timeout"
  | "shell_unavailable"
  | "spawn_error"
  | "callback_error"
  | "unknown";

/** Failure returned by a {@link PiFileSystem} operation. */
export class PiFileError extends Error {
  readonly code: PiFileErrorCode;
  /** Absolute addressed path associated with the failure, when known. */
  readonly path: string | undefined;

  constructor(
    code: PiFileErrorCode,
    message: string,
    path?: string,
    cause?: Error
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PiFileError";
    this.code = code;
    this.path = path;
  }
}

/** Failure returned by {@link PiShell.exec}. */
export class PiExecutionError extends Error {
  readonly code: PiExecutionErrorCode;

  constructor(code: PiExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PiExecutionError";
    this.code = code;
  }
}

/** Metadata for one filesystem object. */
export type PiFileInfo = {
  /** Basename of `path`. */
  readonly name: string;
  /** Absolute, normalized addressed path. */
  readonly path: string;
  readonly kind: PiFileKind;
  readonly size: number;
  readonly mtimeMs: number;
};

/**
 * Filesystem used by pi's built-in `read`, `write`, and `edit` tools and by
 * its skill and prompt-template loaders.
 *
 * Paths may be absolute or relative to `cwd`. Methods must never throw or
 * reject: every failure, including unexpected backend failures, is returned
 * as a {@link PiResult} error.
 */
export interface PiFileSystem {
  /** Current working directory for relative paths. */
  cwd: string;
  absolutePath(
    path: string,
    context: PiContext
  ): Promise<PiResult<string, PiFileError>>;
  joinPath(
    parts: readonly string[],
    context: PiContext
  ): Promise<PiResult<string, PiFileError>>;
  readTextFile(
    path: string,
    context: PiContext
  ): Promise<PiResult<string, PiFileError>>;
  readTextLines(
    path: string,
    options: { readonly maxLines?: number } | undefined,
    context: PiContext
  ): Promise<PiResult<string[], PiFileError>>;
  readBinaryFile(
    path: string,
    context: PiContext
  ): Promise<PiResult<Uint8Array, PiFileError>>;
  /** Create or overwrite a file, creating parent directories. */
  writeFile(
    path: string,
    content: string | Uint8Array,
    context: PiContext
  ): Promise<PiResult<void, PiFileError>>;
  appendFile(
    path: string,
    content: string | Uint8Array,
    context: PiContext
  ): Promise<PiResult<void, PiFileError>>;
  renameFile(
    sourcePath: string,
    destinationPath: string,
    context: PiContext
  ): Promise<PiResult<void, PiFileError>>;
  /** Metadata for the addressed path without following symlinks. */
  fileInfo(
    path: string,
    context: PiContext
  ): Promise<PiResult<PiFileInfo, PiFileError>>;
  listDir(
    path: string,
    context: PiContext
  ): Promise<PiResult<PiFileInfo[], PiFileError>>;
  /** Canonical path of an existing path; may return `not_supported`. */
  canonicalPath(
    path: string,
    context: PiContext
  ): Promise<PiResult<string, PiFileError>>;
  exists(
    path: string,
    context: PiContext
  ): Promise<PiResult<boolean, PiFileError>>;
  createDir(
    path: string,
    options: { readonly recursive?: boolean } | undefined,
    context: PiContext
  ): Promise<PiResult<void, PiFileError>>;
  remove(
    path: string,
    options:
      | { readonly recursive?: boolean; readonly force?: boolean }
      | undefined,
    context: PiContext
  ): Promise<PiResult<void, PiFileError>>;
  createTempDir(
    prefix: string | undefined,
    context: PiContext
  ): Promise<PiResult<string, PiFileError>>;
  createTempFile(
    options: { readonly prefix?: string; readonly suffix?: string } | undefined,
    context: PiContext
  ): Promise<PiResult<string, PiFileError>>;
  /** Release resources. Best-effort; must not throw or reject. */
  cleanup(context: PiContext): Promise<void>;
}

/** Options for {@link PiShell.exec}. */
export type PiShellExecOptions = {
  /** Working directory; defaults to the environment's `cwd`. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Inherit the environment's default variables. @default true */
  readonly inheritEnv?: boolean;
  /** Timeout in seconds. Defaults to no timeout. */
  readonly timeout?: number;
  readonly onStdout?: (chunk: string, context: PiContext) => void;
  readonly onStderr?: (chunk: string, context: PiContext) => void;
};

/** Shell used by pi's built-in `bash` tool. */
export interface PiShell {
  exec(
    command: string,
    options: PiShellExecOptions | undefined,
    context: PiContext
  ): Promise<
    PiResult<
      {
        readonly stdout: string;
        readonly stderr: string;
        readonly exitCode: number;
      },
      PiExecutionError
    >
  >;
  /** Release resources. Best-effort; must not throw or reject. */
  cleanup(context: PiContext): Promise<void>;
}

/**
 * Filesystem plus shell: the computer pi's built-in tools operate on. A
 * container, a remote sandbox, or a SQLite-backed workspace can implement it.
 */
export interface PiExecutionEnv extends PiFileSystem, PiShell {}

/** Tool context required by pi's built-in execution tools. */
export type PiExecutionToolContext = {
  readonly env: PiExecutionEnv;
};

// ── Resources ─────────────────────────────────────────────────────────────

/** Skill available to the model and to explicit skill operations. */
export type PiSkill = {
  /** Stable name used for lookup and model-visible listings. */
  readonly name: string;
  readonly description: string;
  /** Full skill instructions. */
  readonly content: string;
  /** Absolute path shown to the model and used to resolve relative references. */
  readonly filePath: string;
  /** Hide from model-visible listings while allowing explicit invocation. */
  readonly disableModelInvocation?: boolean;
};

/** Prompt template invoked explicitly with positional arguments. */
export type PiPromptTemplate = {
  readonly name: string;
  readonly description?: string;
  readonly content: string;
};

/** Resources available to explicit skill and prompt-template operations. */
export type PiResources = {
  readonly skills?: readonly PiSkill[];
  readonly promptTemplates?: readonly PiPromptTemplate[];
};

/** Diagnostic produced while loading skills or prompt templates from files. */
export type PiResourceDiagnostic = {
  readonly type: "warning";
  readonly code: string;
  readonly message: string;
  readonly path: string;
};

// ── Configuration ─────────────────────────────────────────────────────────

/** Configuration for the Durable Object hosted pi harness. */
export type PiHarnessConfig<
  ToolContext extends object | undefined = object | undefined
> = {
  /** Pi provider registry used for model lookup and streaming. */
  readonly models: PiModels;
  /**
   * Initial model for newly created lanes: a catalog model object, or a
   * provider and model id resolved against `models` when the harness attaches.
   */
  readonly model: PiModel | PiModelIdentity;
  /**
   * Durable execution for operations. Each lane's work runs as one Task run
   * that replays after eviction; pi's session is the recovery evidence.
   */
  readonly tasks: Tasks;
  /** Durable output. Every operation's live events land in one stream. */
  readonly streams: Streams;
  readonly thinkingLevel?: PiThinkingLevel;
  readonly activeToolNames?: readonly string[];
  /** Static tools or a hook re-run before every drive pass. */
  readonly tools?: PiToolSource<ToolContext>;
  readonly toolContext?:
    | ToolContext
    | ((context: PiContext) => ToolContext | Promise<ToolContext>);
  readonly systemPrompt?:
    | string
    | ((
        toolContext: ToolContext,
        context: PiContext
      ) => string | Promise<string>);
  /** Skills and prompt templates supplied directly, re-read on every wake. */
  readonly resources?:
    | PiResources
    | ((context: PiContext) => PiResources | Promise<PiResources>);
  /**
   * Skill sources from `agents/skills`. Skills become explicit-invocation
   * resources and are offered to the model through `activate_skill` and
   * `read_skill_resource` tools plus a catalog in the system prompt.
   */
  readonly skills?: readonly SkillSource[];
  readonly streamOptions?: PiStreamOptions;
  readonly retry?: PiRetryPolicy;
  readonly compaction?: PiCompactionSettings;
  readonly steeringMode?: "all" | "one-at-a-time";
  readonly followUpMode?: "all" | "one-at-a-time";
  readonly toolExecution?: "sequential" | "parallel";
  /** Default lane used when a call names none. @default "main" */
  readonly defaultLane?: string;
  /** Register process-local hooks after each isolate wake. */
  readonly configure?: (
    hooks: PiHookRegistry,
    context: PiContext
  ) => void | Promise<void>;
};

// ── Operations ────────────────────────────────────────────────────────────

/** Operation kind as recorded by pi. */
export type PiOperationKind = "run" | "compaction" | "navigation";

/** Text with optional images, accepted wherever a message is submitted. */
export type PiMessageInput =
  | string
  | { readonly text: string; readonly images?: readonly PiImage[] };

/** Operation submitted to a lane. */
export type PiOperationRequest =
  | {
      readonly kind: "prompt";
      readonly operationId?: string;
      readonly prompt: string;
      readonly images?: readonly PiImage[];
    }
  | {
      readonly kind: "skill";
      readonly operationId?: string;
      readonly name: string;
      readonly additionalInstructions?: string;
    }
  | {
      readonly kind: "prompt_template";
      readonly operationId?: string;
      readonly name: string;
      readonly args?: readonly string[];
    }
  | {
      readonly kind: "compaction";
      readonly operationId?: string;
      readonly customInstructions?: string;
    }
  | {
      readonly kind: "navigation";
      readonly operationId?: string;
      /** Entry to make the branch tip, or null for the branch root. */
      readonly targetId: string | null;
      readonly summarize?: boolean;
      readonly label?: string;
      readonly customInstructions?: string;
    };

/** Immutable terminal disposition retained by pi. */
export type PiOperationResult = {
  readonly operationId: string;
  readonly kind: PiOperationKind;
  readonly status: "completed" | "declined" | "aborted" | "failed";
  readonly error?: { readonly code: string; readonly message: string };
  readonly fromTipId: string | null;
  readonly tipId: string | null;
  readonly startedAt: number;
  readonly endedAt: number;
};

/** Durable provider handle returned when a request continues asynchronously. */
export type PiDeferredHandle = {
  readonly provider: string;
  readonly modelId: string;
  readonly api: string;
  readonly id: string;
  readonly expiresAt?: number;
  readonly pollAfterMs?: number;
  readonly data?: PiJson;
};

/** One display-ready part projected from pi's durable transcript. */
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

/** One display-ready message projected from a pi message entry. */
export type PiMessage = {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly parts: readonly PiMessagePart[];
  readonly timestamp: number;
  readonly stopReason?: string;
  readonly error?: string;
};

/** Compact streaming delta for an in-flight assistant message. */
export type PiMessageDelta =
  | { readonly type: "start"; readonly message: PiMessage }
  | {
      readonly type: "text_start";
      readonly index: number;
      readonly text: string;
    }
  | {
      readonly type: "text_delta";
      readonly index: number;
      readonly delta: string;
    }
  | { readonly type: "text_end"; readonly index: number; readonly text: string }
  | {
      readonly type: "thinking_start";
      readonly index: number;
      readonly text: string;
    }
  | {
      readonly type: "thinking_delta";
      readonly index: number;
      readonly delta: string;
    }
  | {
      readonly type: "thinking_end";
      readonly index: number;
      readonly text: string;
    }
  | {
      readonly type: "toolcall_start";
      readonly index: number;
      readonly id: string;
      readonly name: string;
      readonly arguments: PiJson;
    }
  | {
      readonly type: "toolcall_checkpoint";
      readonly index: number;
      readonly json: string;
    }
  | {
      readonly type: "toolcall_delta";
      readonly index: number;
      readonly delta: string;
    }
  | {
      readonly type: "toolcall_end";
      readonly index: number;
      readonly id: string;
      readonly name: string;
      readonly arguments: PiJson;
    };

/** Message queued for a running or future operation. */
export type PiQueuedItem = {
  readonly entryId: string;
  readonly kind: "steer" | "followUp" | "nextRun" | "write";
  readonly message?: PiMessage;
};

/** Tool call currently executing inside an operation. */
export type PiRunningTool = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: PiJson;
  readonly partial?: PiToolResult;
};

/** Live status of a lane's current operation. */
export type PiOperationStatus = {
  readonly operationId: string;
  readonly kind: PiOperationKind;
  readonly status: "running" | "aborting";
  readonly startedAt: number;
  /** Assistant message being streamed, rebuilt from durable progress. */
  readonly streaming?: PiMessage;
  readonly runningTools: readonly PiRunningTool[];
  readonly retry?: {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly nextAttemptAt: number;
  };
  readonly deferred?: PiDeferredHandle;
};

/** Submission accepted by the harness but not yet admitted by pi. */
export type PiPendingSubmission = {
  readonly operationId: string;
  readonly lane: string;
  readonly request: PiOperationRequest;
  readonly submittedAt: number;
};

/** Durable output stream of one operation. */
export type PiOperationStream = {
  readonly streamId: string;
  readonly operationId: string;
  /** Next chunk sequence number; replay from a lower cursor to catch up. */
  readonly cursor: number;
};

/** Point-in-time view of one lane. */
export type PiLaneSnapshot = {
  readonly lane: string;
  readonly messages: readonly PiMessage[];
  readonly operation: PiOperationStatus | null;
  readonly stream: PiOperationStream | null;
  readonly pending: readonly PiPendingSubmission[];
  readonly queue: readonly PiQueuedItem[];
  readonly model: PiModelIdentity;
  readonly thinkingLevel: PiThinkingLevel;
  readonly activeTools: readonly string[];
  readonly usage: PiUsage;
};

/** Live event projected from pi's harness events. */
export type PiEvent =
  | {
      readonly type: "operation_start";
      readonly operationId: string;
      readonly kind: PiOperationKind;
      readonly startedAt: number;
    }
  | ({ readonly type: "operation_end" } & PiOperationResult)
  | { readonly type: "operation_abort"; readonly operationId: string }
  | {
      readonly type: "operation_wait";
      readonly operationId: string;
      readonly reason: "retry";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly notBefore: number;
      readonly message: string;
    }
  | {
      readonly type: "operation_wait";
      readonly operationId: string;
      readonly reason: "deferred";
      readonly deferred: PiDeferredHandle;
    }
  | { readonly type: "operation_resume"; readonly operationId: string }
  | {
      readonly type: "turn_start";
      readonly operationId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "turn_end";
      readonly operationId: string;
      readonly turnId: string;
    }
  | {
      readonly type: "message_start";
      readonly operationId?: string;
      readonly message: PiMessage;
    }
  | {
      readonly type: "message_delta";
      readonly operationId: string;
      readonly delta: PiMessageDelta;
    }
  | {
      readonly type: "message_end";
      readonly operationId?: string;
      readonly entryId?: string;
    }
  | { readonly type: "message"; readonly message: PiMessage }
  | {
      readonly type: "tool_start";
      readonly operationId: string;
      readonly turnId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments: PiJson;
    }
  | {
      readonly type: "tool_update";
      readonly operationId: string;
      readonly turnId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly partial: PiToolResult;
    }
  | {
      readonly type: "tool_end";
      readonly operationId: string;
      readonly turnId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: PiToolResult;
      readonly error: boolean;
    }
  | { readonly type: "queue_update"; readonly queue: readonly PiQueuedItem[] }
  | {
      readonly type: "config_update";
      readonly property: "model" | "thinkingLevel" | "activeTools";
      readonly value: PiJson;
    }
  | {
      readonly type: "compaction_start";
      readonly operationId: string;
      readonly reason: "manual" | "threshold" | "overflow";
    }
  | {
      readonly type: "compaction_end";
      readonly operationId: string;
      readonly reason: "manual" | "threshold" | "overflow";
      readonly status: "completed" | "declined" | "aborted" | "failed";
    }
  | {
      readonly type: "navigation_start";
      readonly operationId: string;
      readonly targetId: string | null;
    }
  | {
      readonly type: "navigation_end";
      readonly operationId: string;
      readonly status: "completed" | "declined" | "aborted" | "failed";
    }
  | {
      /** The committed transcript changed shape; re-read messages. */
      readonly type: "transcript_reset";
      readonly reason: "compaction" | "navigation";
    }
  | { readonly type: "fault"; readonly code: string; readonly message: string };

/** Envelope for events delivered to in-process listeners. */
export type PiEventContext = {
  readonly lane: string;
  readonly operationId?: string;
};

/** In-process event listener. Deliveries are synchronous and best-effort. */
export type PiEventListener = (event: PiEvent, context: PiEventContext) => void;

/** Pi prompt outcome with the updated display-ready transcript. */
export type PiPromptResponse = PiOperationResult & {
  readonly messages: readonly PiMessage[];
};

/** Options for reading one lane's durable transcript. */
export type PiTranscriptOptions = {
  readonly lane?: string;
  readonly order?: "newestFirst" | "oldestFirst";
  readonly context?: PiContext;
};

/** Options naming a lane and carrying an invocation context. */
export type PiLaneOptions = {
  readonly lane?: string;
  readonly context?: PiContext;
};

/** Options for submitting one durable pi operation. */
export type PiSubmitOptions = PiLaneOptions & {
  readonly operationId?: string;
};

/** Durable receipt returned before a submitted operation has to settle. */
export type PiSubmissionReceipt = {
  readonly operationId: string;
  readonly lane: string;
  /** False when this operation id was already submitted or settled. */
  readonly accepted: boolean;
};

/** Receipt for a message queued into a lane's inbox. */
export type PiQueueReceipt = {
  readonly entryId: string;
};

/** Outcome of a durable abort request. */
export type PiAbortResult = {
  readonly operationId: string;
  /** False when the operation was already aborting. */
  readonly newlyRequested: boolean;
} | null;

/** Minimal lane access exposed for advanced use. */
export interface PiLane {
  /** Read transcript entries newest first unless the query overrides it. */
  findEntries(
    query: { readonly order?: "newestFirst" | "oldestFirst" } | undefined,
    context: PiContext
  ): Promise<unknown[]>;
  /** Read one immutable terminal operation result. */
  getResult(
    operationId: string,
    context: PiContext
  ): Promise<PiOperationResult | undefined>;
  /** Inspect current operation identity and status. */
  inspectExecution(context: PiContext): Promise<unknown>;
}

/** Wire message sent by a browser client over the WebSockets transport. */
export type PiClientMessage =
  | {
      readonly type: "subscribe";
      readonly id?: string;
      readonly streamId: string;
      /** Replay from this chunk sequence; omit or 0 for the whole stream. */
      readonly from?: number;
    }
  | {
      readonly type: "unsubscribe";
      readonly id?: string;
      readonly streamId: string;
    }
  | { readonly type: "snapshot"; readonly id: string }
  | { readonly type: "messages"; readonly id: string }
  | {
      readonly type: "submit";
      readonly id: string;
      readonly request: PiOperationRequest;
    }
  | {
      readonly type: "abort";
      readonly id: string;
      readonly operationId?: string;
    }
  | {
      readonly type: "steer" | "follow_up" | "next_run";
      readonly id: string;
      readonly message: PiMessageInput;
    }
  | {
      readonly type: "cancel_queued";
      readonly id: string;
      readonly entryId: string;
    }
  | {
      readonly type: "set_model";
      readonly id: string;
      readonly model: PiModelIdentity;
    }
  | {
      readonly type: "set_thinking_level";
      readonly id: string;
      readonly level: PiThinkingLevel;
    };

/** Wire message sent to a browser client over the WebSockets transport. */
export type PiServerMessage =
  | {
      readonly type: "snapshot";
      readonly id?: string;
      readonly snapshot: PiLaneSnapshot;
    }
  | {
      /** One durable chunk of an operation stream. */
      readonly type: "events";
      readonly lane: string;
      readonly streamId: string;
      readonly operationId: string;
      /** Sequence of the first chunk in this batch. */
      readonly seq: number;
      /** Sequence of the last chunk; resubscribe from `lastSeq + 1`. */
      readonly lastSeq: number;
      readonly events: readonly PiEvent[];
    }
  | {
      /** A lane event that happened while no operation stream was open. */
      readonly type: "event";
      readonly lane: string;
      readonly event: PiEvent;
    }
  | {
      /** A new operation opened a stream on the subscribed lane. */
      readonly type: "stream_start";
      readonly lane: string;
      readonly streamId: string;
      readonly operationId: string;
    }
  | {
      readonly type: "stream_end";
      readonly lane: string;
      readonly streamId: string;
      readonly operationId: string;
    }
  | { readonly type: "result"; readonly id: string; readonly result: PiJson }
  | { readonly type: "error"; readonly id?: string; readonly message: string };
