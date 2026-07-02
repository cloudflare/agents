/** Common AI SDK v7 telemetry callback options this adapter reads. */
export type AISDKV7TelemetryOptions = {
  readonly functionId?: string | undefined;
  readonly recordInputs?: boolean | undefined;
  readonly recordOutputs?: boolean | undefined;
};

/** AI SDK v7 operation lifecycle event shape consumed by this adapter. */
export type AISDKV7OperationEvent = AISDKV7TelemetryOptions & {
  readonly callId: string;
  readonly finishReason?: unknown;
  readonly frequencyPenalty?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly maxTokens?: unknown;
  readonly metadata?: unknown;
  readonly messages?: unknown;
  readonly modelId?: string | undefined;
  readonly object?: unknown;
  readonly operationId?: string | undefined;
  readonly presencePenalty?: unknown;
  readonly prompt?: unknown;
  readonly provider?: string | undefined;
  readonly response?: unknown;
  readonly responseId?: unknown;
  readonly responseModel?: unknown;
  readonly runtimeContext?: unknown;
  readonly seed?: unknown;
  readonly temperature?: unknown;
  readonly text?: unknown;
  readonly toolCalls?: unknown;
  readonly toolsContext?: unknown;
  readonly topK?: unknown;
  readonly topP?: unknown;
  readonly totalUsage?: unknown;
  readonly usage?: unknown;
};

/** AI SDK v7 language-model lifecycle event shape consumed by this adapter. */
export type AISDKV7LanguageModelCallEvent = AISDKV7TelemetryOptions & {
  readonly callId: string;
  readonly finishReason?: unknown;
  readonly frequencyPenalty?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly maxTokens?: unknown;
  readonly modelId?: string | undefined;
  readonly presencePenalty?: unknown;
  readonly provider?: string | undefined;
  readonly response?: unknown;
  readonly responseId?: unknown;
  readonly responseModel?: unknown;
  readonly seed?: unknown;
  readonly temperature?: unknown;
  readonly topK?: unknown;
  readonly topP?: unknown;
  readonly totalUsage?: unknown;
  readonly usage?: unknown;
};

/** AI SDK v7 tool-call identity shape consumed by this adapter. */
export type AISDKV7ToolCall = {
  readonly input?: unknown;
  readonly toolCallId?: string | undefined;
  readonly toolName?: string | undefined;
};

/** AI SDK v7 tool-output event shape consumed by this adapter. */
export type AISDKV7ToolOutput = {
  readonly error?: unknown;
  readonly output?: unknown;
  readonly type?: string | undefined;
};

/** AI SDK v7 tool lifecycle event shape consumed by this adapter. */
export type AISDKV7ToolExecutionEvent = AISDKV7TelemetryOptions & {
  readonly callId: string;
  readonly toolCall: AISDKV7ToolCall;
  readonly toolContext?: unknown;
  readonly toolOutput?: AISDKV7ToolOutput | undefined;
};

/** AI SDK v7 tool execution hook shape consumed by this adapter. */
export type AISDKV7ExecuteToolOptions<T> = {
  readonly callId: string;
  readonly execute: () => PromiseLike<T>;
  readonly toolCallId: string;
};

/** Structural AI SDK v7 telemetry object returned by this package. */
export type AISDKV7Telemetry = {
  readonly executeTool?: <T>(
    options: AISDKV7ExecuteToolOptions<T>
  ) => PromiseLike<T>;
  readonly onEnd?: (event: AISDKV7OperationEvent) => void | PromiseLike<void>;
  readonly onError?: (event: unknown) => void | PromiseLike<void>;
  readonly onFinish?: (
    event: AISDKV7OperationEvent
  ) => void | PromiseLike<void>;
  readonly onLanguageModelCallEnd?: (
    event: AISDKV7LanguageModelCallEvent
  ) => void | PromiseLike<void>;
  readonly onLanguageModelCallStart?: (
    event: AISDKV7LanguageModelCallEvent
  ) => void | PromiseLike<void>;
  readonly onStart?: (event: AISDKV7OperationEvent) => void | PromiseLike<void>;
  readonly onToolExecutionEnd?: (
    event: AISDKV7ToolExecutionEvent
  ) => void | PromiseLike<void>;
  readonly onToolExecutionStart?: (
    event: AISDKV7ToolExecutionEvent
  ) => void | PromiseLike<void>;
};
