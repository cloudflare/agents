import type { Static, TSchema } from "typebox";

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

/** Text or image content returned by a pi tool. */
export type PiToolContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    };

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
export type PiToolResult<Details = unknown> = {
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
  Details = unknown
> = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Parameters;
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

/** Configuration for the Durable Object hosted pi harness. */
export type PiHarnessConfig<
  ToolContext extends object | undefined = object | undefined
> = {
  /** Pi provider registry used for model lookup and streaming. */
  readonly models: PiModels;
  /** Initial model for newly created lanes. */
  readonly model: PiModel;
  readonly thinkingLevel?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  readonly activeToolNames?: readonly string[];
  /** Static tools or a hook re-run before every accept or drive pass. */
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
  readonly streamOptions?: PiStreamOptions;
  readonly retry?: PiRetryPolicy;
  readonly compaction?: PiCompactionSettings;
  readonly steeringMode?: "all" | "one-at-a-time";
  readonly followUpMode?: "all" | "one-at-a-time";
  readonly toolExecution?: "sequential" | "parallel";
  /** Default lane used by submit, prompt, and result. @default "main" */
  readonly defaultLane?: string;
  /** Register process-local hooks after each isolate wake. */
  readonly configure?: (
    hooks: PiHookRegistry,
    context: PiContext
  ) => void | Promise<void>;
};

/** Prompt operation accepted by the v0.1 wrapper. */
export type PiPromptRequest = {
  readonly kind: "prompt";
  readonly operationId?: string;
  readonly prompt: string;
};

/** Operation accepted by the v0.1 wrapper. */
export type PiOperationRequest = PiPromptRequest;

/** Immutable terminal disposition retained by pi. */
export type PiOperationResult = {
  readonly operationId: string;
  readonly kind: "run" | "compaction" | "navigation";
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
  readonly data?: unknown;
};

/** Result of the waiting prompt convenience. */
export type PiPromptOutcome =
  | PiOperationResult
  | {
      readonly operationId: string;
      readonly status: "suspended";
      readonly deferred: PiDeferredHandle;
    };

/** One display-ready part projected from pi's durable transcript. */
export type PiMessagePart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly content: readonly PiToolContent[];
      readonly details?: unknown;
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

/** Pi prompt outcome with the updated display-ready transcript. */
export type PiPromptResponse = PiPromptOutcome & {
  readonly messages: readonly PiMessage[];
};

/** Options for reading one lane's durable transcript. */
export type PiTranscriptOptions = {
  readonly lane?: string;
  readonly order?: "newestFirst" | "oldestFirst";
  readonly context?: PiContext;
};

/** Options for submitting one durable pi operation. */
export type PiSubmitOptions = {
  readonly lane?: string;
  readonly operationId?: string;
  readonly context?: PiContext;
};

/** Durable receipt returned before a submitted operation has to settle. */
export type PiSubmissionReceipt = {
  readonly operationId: string;
  readonly lane: string;
  readonly accepted: boolean;
};

/** Minimal lane access exposed by the v0.1 capability. */
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
