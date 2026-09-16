import type { Static, TSchema } from "typebox";
import type { SkillSource } from "agents/skills";

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

/** Tool definition executed by {@link PiRuntime}. */
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

// ── Configuration ─────────────────────────────────────────────────────────

/**
 * Configuration for the pi runtime. Everything durable belongs to the shared
 * Harness capability: this is the pi engine's own configuration and nothing
 * else.
 */
export type PiRuntimeConfig<
  ToolContext extends object | undefined = object | undefined
> = {
  /** Pi provider registry used for model lookup and streaming. */
  readonly models: PiModels;
  /**
   * Initial model for newly created lanes: a catalog model object, or a
   * provider and model id resolved against `models` when the runtime attaches.
   */
  readonly model: PiModel | PiModelIdentity;
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
  /** Register process-local hooks after each isolate wake. */
  readonly configure?: (
    hooks: PiHookRegistry,
    context: PiContext
  ) => void | Promise<void>;
};

// ── Operations ────────────────────────────────────────────────────────────

/** Operation kind as recorded by pi. */
export type PiOperationKind = "run" | "compaction" | "navigation";

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

/** Message queued for a running or future operation. */
export type PiQueuedItem = {
  readonly entryId: string;
  readonly kind: "steer" | "followUp" | "nextRun" | "write";
  readonly message?: PiMessage;
};

/** One tool offered to the model, for display. */
export type PiToolInfo = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
};

// ── Events ────────────────────────────────────────────────────────────────

/**
 * Live pi event with no core equivalent, carried as a harness extension
 * frame. Messages, tool calls, usage and faults are projected onto the core
 * event bodies instead, so every harness renders them the same way, and
 * token deltas are previews rather than events.
 */
export type PiEvent =
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
  | { readonly type: "message"; readonly message: PiMessage }
  | {
      readonly type: "tool_update";
      readonly operationId: string;
      readonly turnId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly partial: PiToolResult;
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
    };

// ── The harness protocol ──────────────────────────────────────────────────

/**
 * JSON as the shared harness types spell it. `JsonValue` is defined with
 * mutable arrays and without `undefined`, so a readonly pi value is not
 * assignable to it even though it is plain JSON. This widens arrays and drops
 * `undefined`; property names, discriminants and `readonly` are untouched.
 */
export type PiWire<Value> = Value extends undefined
  ? never
  : Value extends readonly (infer Element)[]
    ? PiWire<Element>[]
    : Value extends object
      ? { [Key in keyof Value]: PiWire<Value[Key]> }
      : Value;

/**
 * The operations pi accepts beyond a prompt and a compaction, submitted with
 * `session.submit()`. Each becomes one inbox row of that kind.
 */
export type PiSubmission =
  | {
      readonly kind: "skill";
      readonly payload: {
        readonly name: string;
        readonly additionalInstructions?: string;
      };
    }
  | {
      readonly kind: "prompt_template";
      readonly payload: {
        readonly name: string;
        readonly args?: readonly string[];
      };
    }
  | {
      readonly kind: "navigation";
      readonly payload: {
        /** Entry to make the branch tip, or null for the branch root. */
        readonly targetId: string | null;
        readonly summarize?: boolean;
        readonly label?: string;
        readonly customInstructions?: string;
      };
    };

/**
 * The terminal record of one harness operation: pi's own operation result,
 * or the queue receipt of a steered message, which settles as soon as pi has
 * taken it.
 */
export type PiResult =
  | PiOperationResult
  | { readonly kind: "steer"; readonly entryId: string };

/** Pi's vocabulary at the harness seam: events, submissions and results. */
export type PiProtocol = {
  readonly event: PiWire<PiEvent>;
  readonly submit: PiWire<PiSubmission>;
  readonly result: PiWire<PiResult>;
};
