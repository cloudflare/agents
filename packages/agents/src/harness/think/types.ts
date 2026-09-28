import type {
  LanguageModel,
  ModelMessage,
  StepResult,
  StopCondition,
  TextStreamPart,
  ToolSet,
  UIMessage,
  UIMessageChunk,
  streamText
} from "ai";
import type { Driver } from "../../driver";
import type { Session } from "../../sessions";

type StreamTextOptions = Parameters<typeof streamText>[0];

/** What one turn starts from. Stored durably, so it must be JSON. */
export type ThinkTurnInput = {
  /** Messages to add to the transcript when the turn starts, in order. */
  readonly messages?: UIMessage[];
  /** Caller data the hooks receive, such as a chat request body. */
  readonly body?: Record<string, unknown>;
};

/** The turn a hook is running for. */
export type ThinkTurnContext = {
  readonly chat: string;
  readonly turnId: string;
  /** Model steps this turn has completed. */
  readonly step: number;
  readonly body: Record<string, unknown> | undefined;
};

/**
 * Per-turn overrides `beforeTurn` may return. Each field replaces the
 * harness's default for this turn only.
 */
export type ThinkTurnConfig = {
  readonly model?: LanguageModel;
  readonly system?: string;
  /** Replace the model messages built from the transcript. */
  readonly messages?: ModelMessage[];
  readonly tools?: ToolSet;
  readonly activeTools?: string[];
  readonly toolChoice?: StreamTextOptions["toolChoice"];
  readonly maxSteps?: number;
  readonly stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  readonly sendReasoning?: boolean;
  readonly maxOutputTokens?: StreamTextOptions["maxOutputTokens"];
  readonly temperature?: StreamTextOptions["temperature"];
  readonly topP?: StreamTextOptions["topP"];
  readonly topK?: StreamTextOptions["topK"];
  readonly providerOptions?: StreamTextOptions["providerOptions"];
};

/** Per-step overrides `beforeStep` may return. */
export type ThinkStepConfig = {
  readonly model?: LanguageModel;
  readonly system?: string;
  readonly messages?: ModelMessage[];
  readonly activeTools?: string[];
  readonly toolChoice?: StreamTextOptions["toolChoice"];
  readonly providerOptions?: StreamTextOptions["providerOptions"];
};

/** A tool call about to run. */
export type ThinkToolCall = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
};

export type ThinkToolCallDecision =
  | { readonly action: "allow"; readonly input?: unknown }
  | { readonly action: "block"; readonly reason?: string }
  | { readonly action: "substitute"; readonly output: unknown };

export type ThinkToolResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: string };

/** How a turn ended. */
export type ThinkTurnStatus = "completed" | "error" | "stopped";

export type ThinkTurnEnd = ThinkTurnContext & {
  readonly status: ThinkTurnStatus;
  /** The assistant message this turn produced, if it produced one. */
  readonly message: UIMessage | undefined;
  readonly error?: string;
};

/**
 * What a tool may declare about repeating itself when the object is evicted
 * while it runs.
 *
 * - `never` (the default): report the call as interrupted to the model and
 *   do not run it again. The call may or may not have taken effect.
 * - `safe`: run it again. Use it for reads and idempotent writes.
 */
export type ThinkToolRecovery = "never" | "safe";

export interface ThinkHarnessHooks {
  /** Once per turn per isolate, before its first model step here. */
  beforeTurn?(
    turn: ThinkTurnContext
  ): ThinkTurnConfig | void | Promise<ThinkTurnConfig | void>;
  beforeToolCall?(
    turn: ThinkTurnContext & { readonly call: ThinkToolCall }
  ): ThinkToolCallDecision | void | Promise<ThinkToolCallDecision | void>;
  afterToolCall?(
    turn: ThinkTurnContext & {
      readonly call: ThinkToolCall;
      readonly result: ThinkToolResult;
    }
  ): void | Promise<void>;
  /** Before every model call, with the step number across the whole turn. */
  beforeStep?(
    turn: ThinkTurnContext & {
      readonly model: LanguageModel;
      readonly system: string | undefined;
      readonly messages: ModelMessage[];
    }
  ): ThinkStepConfig | void | Promise<ThinkStepConfig | void>;
  /** Every UI message chunk the turn produces, in order. */
  onChunk?(turn: ThinkTurnContext & { readonly chunk: UIMessageChunk }): void;
  /** Every part of the model's own stream, as `streamText`'s `onChunk` sees it. */
  onModelChunk?(
    turn: ThinkTurnContext & { readonly chunk: TextStreamPart<ToolSet> }
  ): void | Promise<void>;
  onStepFinish?(
    turn: ThinkTurnContext & {
      /** The AI SDK's result for this model call. */
      readonly result: StepResult<ToolSet> | undefined;
      readonly finishReason: string | undefined;
      readonly toolCalls: ThinkToolCall[];
    }
  ): void | Promise<void>;
  onTurnEnd?(end: ThinkTurnEnd): void | Promise<void>;
}

export type ThinkHarnessOptions = {
  readonly driver: Driver;
  /** The driver runtime id. Default `"think"`. */
  readonly id?: string;
  /** The transcript for one chat. */
  readonly session: (chat: string) => Session;
  readonly model: (
    turn: ThinkTurnContext
  ) => LanguageModel | Promise<LanguageModel>;
  readonly system?: (
    turn: ThinkTurnContext
  ) => string | undefined | Promise<string | undefined>;
  readonly tools?: (turn: ThinkTurnContext) => ToolSet | Promise<ToolSet>;
  /** Model steps per turn. Default 10. */
  readonly maxSteps?: number;
  readonly hooks?: ThinkHarnessHooks;
};

export type ThinkTurnReceipt = {
  readonly turnId: string;
  readonly chat: string;
  readonly accepted: boolean;
};

/** A turn as the harness records it. */
export type ThinkTurnRecord = {
  readonly turnId: string;
  readonly chat: string;
  readonly status: "running" | ThinkTurnStatus;
  readonly step: number;
  readonly messageId: string;
  readonly error: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
};
