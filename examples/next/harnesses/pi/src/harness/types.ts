import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionUIContext
} from "../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import type { ResourceLoader } from "./extensions/resource-loader";
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

// ── Extensions ────────────────────────────────────────────────────────────

/**
 * Pi's own extension API, as an extension factory receives it: event
 * subscription, tool and command registration, flags, and the actions that
 * reach back into the session.
 */
export type PiExtensionApi = ExtensionAPI;

/** An extension's registration function. */
export type PiExtensionFactory = ExtensionFactory;

/**
 * The blocking UI surface `ctx.ui` exposes to an extension. The harness runs
 * with pi's no-op context unless a host supplies one.
 */
export type PiExtensionUiContext = ExtensionUIContext;

/**
 * Pi's resource surface: extensions, skills, prompt templates, themes and
 * context files. The harness serves an in-memory one built from its own
 * configuration.
 */
export type PiResourceLoader = ResourceLoader;

/** One extension: a bare factory, or a factory with a display name. */
export type PiExtension =
  | PiExtensionFactory
  | {
      /** Name reported as the extension's path in diagnostics. */
      readonly name: string;
      readonly factory: PiExtensionFactory;
      /** Hide this extension from user-visible listings. */
      readonly hidden?: boolean;
    };

// ── Configuration ─────────────────────────────────────────────────────────

/** Configuration for the Durable Object hosted pi harness. */
/**
 * Pi's filesystem and shell capability. Implementations never throw: every
 * method resolves to pi's `Result`.
 */
export type PiExecutionEnv = ExecutionEnv;

/** Pi's own execution tools, selectable through the harness config. */
export type PiBuiltinToolName = "read" | "write" | "edit" | "bash";

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
  /**
   * Filesystem and shell pi's built-in tools run against. Also supplied to
   * tools as `toolContext.env`, merged over any application tool context.
   */
  readonly executionEnv?: PiExecutionEnv;
  /**
   * Pi's own execution tools to offer, in order, ahead of application tools.
   * Requires {@link PiHarnessConfig.executionEnv}; defaults to none.
   */
  readonly builtinTools?: readonly PiBuiltinToolName[];
  /**
   * Pi extensions loaded into this harness. They register tools, commands,
   * flags, and event handlers, and are re-loaded on every isolate wake.
   */
  readonly extensions?:
    | readonly PiExtension[]
    | ((
        context: PiContext
      ) => readonly PiExtension[] | Promise<readonly PiExtension[]>);
  /**
   * Prompt templates offered as slash commands. A submitted `/name args`
   * that no extension command claims becomes a durable `prompt_template`
   * operation; the templates are also added to the harness's resources.
   */
  readonly promptTemplates?: readonly PiPromptTemplate[];
  /** Working directory extensions and their tools see. @default "/" */
  readonly cwd?: string;
  /** Initial values for extension-registered flags, by flag name. */
  readonly flags?: Readonly<Record<string, boolean | string>>;
  /**
   * Resource surface served to pi, replacing the in-memory default built
   * from this configuration.
   */
  readonly resourceLoader?: PiResourceLoader;
  /**
   * How long a blocking extension UI request waits for a client answer
   * before resolving to its default. @default 30000
   */
  readonly uiRequestTimeoutMs?: number;
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

/** One tool offered to the model, for display. */
export type PiToolInfo = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
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
  /** Every registered tool, including skill tools. */
  readonly tools: readonly PiToolInfo[];
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
  | {
      /**
       * A hook, event handler, or extension threw. The operation continues:
       * pi isolates handler failures from the run.
       */
      readonly type: "handler_error";
      readonly kind: "hook" | "event" | "extension";
      /** Hook name, event type, or extension path the failure came from. */
      readonly source: string;
      readonly message: string;
      readonly stack?: string;
    }
  | { readonly type: "fault"; readonly code: string; readonly message: string };

/**
 * One custom transcript entry, as `pi.appendEntry` persists it. Custom
 * entries are extension state, not model context: they carry no message and
 * never reach the provider.
 */
export type PiCustomEntry = {
  readonly id: string;
  readonly customType: string;
  readonly data?: PiJson;
  readonly timestamp: number;
};

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
  /**
   * True when an extension's `input` handler consumed the submission. No
   * operation was queued.
   */
  readonly handled?: boolean;
  /**
   * The extension slash command this submission ran instead of queueing an
   * operation. Commands run out of band, so `accepted` is false.
   */
  readonly command?: string;
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

/**
 * One extension UI request, addressed by `requestId`.
 *
 * Shapes follow pi's RPC mode (`modes/rpc/rpc-types.ts`
 * `RpcExtensionUIRequest`) with snake_case methods and a lane-scoped id. The
 * first four methods are dialogs and expect a `PiExtensionUiResponse`; the
 * rest are fire-and-forget view updates the client applies to its own state.
 */
export type PiExtensionUiRequest =
  | {
      readonly method: "select";
      readonly requestId: string;
      readonly title: string;
      readonly options: readonly string[];
      /** Milliseconds after which the harness answers with the default. */
      readonly timeoutMs: number;
    }
  | {
      readonly method: "confirm";
      readonly requestId: string;
      readonly title: string;
      readonly message: string;
      readonly timeoutMs: number;
    }
  | {
      readonly method: "input";
      readonly requestId: string;
      readonly title: string;
      readonly placeholder?: string;
      readonly timeoutMs: number;
    }
  | {
      readonly method: "editor";
      readonly requestId: string;
      readonly title: string;
      readonly prefill?: string;
      readonly timeoutMs: number;
    }
  | {
      readonly method: "notify";
      readonly requestId: string;
      readonly message: string;
      readonly level?: "info" | "warning" | "error";
    }
  | {
      readonly method: "set_status";
      readonly requestId: string;
      readonly key: string;
      /** Undefined clears the status slot. */
      readonly text: string | undefined;
    }
  | {
      readonly method: "set_widget";
      readonly requestId: string;
      readonly key: string;
      /** Undefined clears the widget. Component factories are not sent. */
      readonly lines: readonly string[] | undefined;
      readonly placement?: "aboveEditor" | "belowEditor";
    }
  | {
      readonly method: "set_title";
      readonly requestId: string;
      readonly title: string;
    }
  | {
      readonly method: "set_editor_text";
      readonly requestId: string;
      readonly text: string;
    };

/** A client's answer to one extension UI dialog. */
export type PiExtensionUiResponse =
  | { readonly value: string }
  | { readonly confirmed: boolean }
  | { readonly cancelled: true };

/** One slash command offered to the client's autocomplete. */
export type PiSlashCommand = {
  readonly name: string;
  readonly description: string;
  readonly source: "extension" | "template" | "skill";
};

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
      /** Queue a message the running operation reads at its next turn. */
      readonly type: "steer";
      readonly id: string;
      readonly message: PiMessageInput;
    }
  | {
      /** Answer one extension UI dialog. */
      readonly type: "extension_ui_response";
      readonly id?: string;
      readonly requestId: string;
      readonly response: PiExtensionUiResponse;
    }
  | {
      /** Ask for the lane's slash commands; answered with a `commands` frame. */
      readonly type: "get_commands";
      readonly id: string;
    }
  | {
      /** Set one extension flag; answered with a `flags` frame. */
      readonly type: "set_flag";
      readonly id: string;
      readonly name: string;
      readonly value: boolean | string;
    }
  | {
      /** Run one slash command out of band from durable operations. */
      readonly type: "command";
      readonly id: string;
      readonly name: string;
      readonly args?: string;
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
  | { readonly type: "error"; readonly id?: string; readonly message: string }
  | {
      /**
       * An extension asked for UI. `requestId` is lifted out of `request` so a
       * client can correlate an answer without narrowing the method union.
       */
      readonly type: "extension_ui_request";
      readonly lane: string;
      readonly requestId: string;
      readonly request: PiExtensionUiRequest;
    }
  | {
      readonly type: "commands";
      readonly id?: string;
      readonly lane: string;
      readonly commands: readonly PiSlashCommand[];
    }
  | {
      readonly type: "flags";
      readonly id?: string;
      readonly flags: Readonly<Record<string, boolean | string>>;
    }
  | {
      /** A hook, event listener or extension threw; the run carries on. */
      readonly type: "handler_error";
      readonly lane: string;
      readonly kind: "hook" | "event" | "extension";
      readonly source: string;
      readonly message: string;
      readonly stack?: string;
    };
