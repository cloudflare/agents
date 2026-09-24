import type { Static, TSchema } from "typebox";
import type { SkillSource } from "../skills";
import type { Streams } from "../streams";

export interface PiContext {
  readonly abortSignal: AbortSignal | undefined;

  value<Value>(key: PiContextKey<Value>): Value | undefined;

  toString(): string;
}

export interface PiContextKey<Value> {
  readonly token: symbol;

  readonly valueType?: (value: Value) => Value;
}

export type PiModel = {
  readonly id: string;
  readonly provider: string;
  readonly api: string;
} & object;

export type PiModels = object;

export type PiModelIdentity = {
  readonly provider: string;
  readonly modelId: string;
};

export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type PiJson =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly PiJson[]
  | { readonly [key: string]: PiJson };

export type PiImage = {
  readonly data: string;
  readonly mimeType: string;
};

export type PiToolContent =
  | { readonly type: "text"; readonly text: string }
  | ({ readonly type: "image" } & PiImage);

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

export type PiToolResult<Details = PiJson> = {
  readonly content: readonly PiToolContent[];
  readonly details: Details;
  readonly usage?: PiUsage;
  readonly terminate?: boolean;
};

export type PiToolUpdateOptions = {
  readonly checkpoint?: true;
};

export type PiToolUpdate<Details> = (
  partial: PiToolResult<Details>,
  options?: PiToolUpdateOptions
) => void;

export interface PiToolInvocation {
  readonly invocationId: string;
  readonly operationId: string;
  readonly turnId: string;

  getMemo(name: string): Promise<unknown>;

  setMemo(name: string, value: unknown | undefined): Promise<void>;
}

export type PiTool<
  ToolContext extends object | undefined = object | undefined,
  Parameters extends TSchema = TSchema,
  Details = PiJson
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

export type PiToolSource<
  ToolContext extends object | undefined = object | undefined
> =
  | readonly PiTool<ToolContext>[]
  | ((
      context: PiContext
    ) =>
      | readonly PiTool<ToolContext>[]
      | Promise<readonly PiTool<ToolContext>[]>);

export interface PiHookRegistry {
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

export type PiRetryPolicy = {
  readonly enabled: boolean;
  readonly maxRetries: number;
  readonly baseDelayMs: number;
};

export type PiCompactionSettings = {
  readonly enabled: boolean;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
};

export type PiSkill = {
  readonly name: string;
  readonly description: string;

  readonly content: string;

  readonly filePath: string;

  readonly disableModelInvocation?: boolean;
};

export type PiPromptTemplate = {
  readonly name: string;
  readonly description?: string;
  readonly content: string;
};

export type PiResources = {
  readonly skills?: readonly PiSkill[];
  readonly promptTemplates?: readonly PiPromptTemplate[];
};

export type PiHarnessConfig<
  ToolContext extends object | undefined = object | undefined
> = {
  readonly models: PiModels;

  readonly model: PiModel | PiModelIdentity;

  readonly streams: Streams;
  readonly durableTools?: {
    cancelByOperation(operationId: string): Promise<number>;
  };
  readonly thinkingLevel?: PiThinkingLevel;
  readonly activeToolNames?: readonly string[];

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

  readonly resources?:
    | PiResources
    | ((context: PiContext) => PiResources | Promise<PiResources>);

  readonly skills?: readonly SkillSource[];
  readonly streamOptions?: PiStreamOptions;
  readonly retry?: PiRetryPolicy;
  readonly compaction?: PiCompactionSettings;
  readonly steeringMode?: "all" | "one-at-a-time";
  readonly followUpMode?: "all" | "one-at-a-time";
  readonly toolExecution?: "sequential" | "parallel";

  readonly defaultLane?: string;

  readonly configure?: (
    hooks: PiHookRegistry,
    context: PiContext
  ) => void | Promise<void>;
};

export type PiOperationKind = "run" | "compaction" | "navigation";

export type PiMessageInput =
  | string
  | { readonly text: string; readonly images?: readonly PiImage[] };

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

      readonly targetId: string | null;
      readonly summarize?: boolean;
      readonly label?: string;
      readonly customInstructions?: string;
    };

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

export type PiDeferredHandle = {
  readonly provider: string;
  readonly modelId: string;
  readonly api: string;
  readonly id: string;
  readonly expiresAt?: number;
  readonly pollAfterMs?: number;
  readonly data?: PiJson;
};

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

export type PiMessage = {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly parts: readonly PiMessagePart[];
  readonly timestamp: number;
  readonly stopReason?: string;
  readonly error?: string;
};

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

export type PiQueuedItem = {
  readonly entryId: string;
  readonly kind: "steer" | "followUp" | "nextRun" | "write";
  readonly message?: PiMessage;
};

export type PiRunningTool = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: PiJson;
  readonly partial?: PiToolResult;
};

export type PiOperationStatus = {
  readonly operationId: string;
  readonly kind: PiOperationKind;
  readonly status: "running" | "aborting";
  readonly startedAt: number;

  readonly streaming?: PiMessage;
  readonly runningTools: readonly PiRunningTool[];
  readonly retry?: {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly nextAttemptAt: number;
  };
  readonly deferred?: PiDeferredHandle;
};

export type PiPendingSubmission = {
  readonly operationId: string;
  readonly lane: string;
  readonly request: PiOperationRequest;
  readonly submittedAt: number;
};

export type PiOperationStream = {
  readonly streamId: string;
  readonly operationId: string;

  readonly cursor: number;
};

export type PiToolInfo = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
};

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

  readonly tools: readonly PiToolInfo[];
  readonly usage: PiUsage;
};

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
      readonly type: "transcript_reset";
      readonly reason: "compaction" | "navigation";
    }
  | { readonly type: "fault"; readonly code: string; readonly message: string };

export type PiEventContext = {
  readonly lane: string;
  readonly operationId?: string;
};

export type PiEventListener = (event: PiEvent, context: PiEventContext) => void;

export type PiPromptResponse = PiOperationResult & {
  readonly messages: readonly PiMessage[];
};

export type PiTranscriptOptions = {
  readonly lane?: string;
  readonly order?: "newestFirst" | "oldestFirst";
  readonly context?: PiContext;
};

export type PiLaneOptions = {
  readonly lane?: string;
  readonly context?: PiContext;
};

export type PiSubmitOptions = PiLaneOptions & {
  readonly operationId?: string;
};

export type PiSubmissionReceipt = {
  readonly operationId: string;
  readonly lane: string;

  readonly accepted: boolean;
};

export type PiQueueReceipt = {
  readonly entryId: string;
};

export type PiAbortResult = {
  readonly operationId: string;

  readonly newlyRequested: boolean;
} | null;

export type PiClientMessage =
  | {
      readonly type: "subscribe";
      readonly id?: string;
      readonly streamId: string;

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
      readonly type: "steer";
      readonly id: string;
      readonly message: PiMessageInput;
    };

export type PiServerMessage =
  | {
      readonly type: "snapshot";
      readonly id?: string;
      readonly snapshot: PiLaneSnapshot;
    }
  | {
      readonly type: "events";
      readonly lane: string;
      readonly streamId: string;
      readonly operationId: string;

      readonly seq: number;

      readonly lastSeq: number;
      readonly events: readonly PiEvent[];
    }
  | {
      readonly type: "event";
      readonly lane: string;
      readonly event: PiEvent;
    }
  | {
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
