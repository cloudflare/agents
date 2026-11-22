/**
 * Public turn, hook and option types of `Think`. Re-exported from
 * `@cloudflare/think`.
 */

import type {
  GenerateTextOnStepFinishCallback,
  InferToolOutput,
  LanguageModel,
  ModelMessage,
  PrepareStepFunction,
  PrepareStepResult,
  StopCondition,
  StreamTextOnChunkCallback,
  TextStreamPart,
  ToolSet,
  TypedToolCall,
  UIMessage,
  streamText
} from "ai";
import type {
  ClientToolExecutor,
  ClientToolSchema,
  SaveMessagesResult
} from "agents/chat";
import type { SessionMessage } from "agents/sessions";
import type { DeliveryKind, MessengerContext } from "./messengers";

/**
 * A best-effort internal `onStart` step that failed on this wake and was
 * skipped so the agent could still come up (#1710).
 *
 * - `transcript-hydration` — reading the persisted conversation into the
 *   in-memory message cache failed (e.g. `SQLITE_NOMEM` on an oversized,
 *   media-heavy transcript). The agent starts with an empty in-memory view;
 *   persisted history is untouched and the next safe-boundary sync retries.
 * - `scheduled-task-reconcile` — declarative scheduled tasks were not
 *   reconciled on this wake; the next successful wake reconciles them.
 * - `durable-work-recovery` — pending submissions / workflow notifications
 *   were not recovered or drained on this wake.
 */
export interface OnStartDegradation {
  step:
    | "transcript-hydration"
    | "scheduled-task-reconcile"
    | "durable-work-recovery";
  error: unknown;
}

/**
 * Callback interface for streaming chat events from a Think sub-agent.
 *
 * Designed to work across the sub-agent RPC boundary — implement as
 * an RpcTarget in the parent agent and pass to `chat()`.
 */
export interface ChatStartEvent {
  requestId: string;
}

/**
 * The sink of a `chat()` turn. The calls are `onStart`, then `onEvent` for
 * each chunk, then one terminal call: `onDone`, `onError` or
 * `onInterrupted`.
 *
 * A turn the caller cancels itself (its `signal`, or `cancelChat()` with the
 * id from `onStart`) gets no terminal call. The promise `chat()` returns
 * resolves, and that is the signal the turn is over. This holds whether the
 * cancel lands while the reply streams (the partial reply is stored) or
 * before the turn's message is stored (nothing is stored and the model is
 * never called).
 *
 * A chat cleared under the turn is reported through `onError`, unless the
 * caller had already cancelled.
 */
export interface StreamCallback {
  onStart(event: ChatStartEvent): void | Promise<void>;
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError(error: string): void | Promise<void>;
  /**
   * The current attempt was interrupted (a stream-stall watchdog abort routed
   * into bounded recovery, #1626) and its final outcome will NOT arrive through
   * this callback. One of two things is true:
   *  - a scheduled continuation — running in a LATER isolate invocation, without
   *    this callback — will produce the answer (delivered to other channels,
   *    e.g. WebSocket connections), OR
   *  - the recovery budget was exhausted, so the turn was already terminalized
   *    out-of-band (the configured `terminalMessage` + `onExhausted`) and is
   *    terminally over — there is NO continuation to come.
   *
   * This is NOT `onDone` (this attempt did not complete) and NOT `onError` (the
   * raw stall is not surfaced as a terminal error here); without it the contract
   * `onStart → onEvent* → (onDone | onError)` is silently abandoned and a
   * consumer that treats the clean resolve as success finalizes a truncated
   * partial.
   *
   * Consumers should AVOID finalizing the partial on this signal — surface a
   * "recovering…" / "interrupted, please retry" state, or re-attach via a
   * durable channel — but must ALSO NOT block indefinitely waiting for a
   * continuation: per the exhausted case above, one may never come. Optional →
   * defaults to a no-op, so this is fully backward-compatible.
   *
   * Note: a deploy/eviction interruption kills the isolate (and this callback)
   * before this can fire — the caller observes a transport break instead. This
   * fires only for an in-isolate interruption (the stall→recovery path).
   *
   * `info.deliversRecoveredReply` is true when the interrupted turn was a
   * messenger turn and this agent will post the recovered answer (or the
   * interrupted apology, if recovery gives up) to the messenger thread itself.
   */
  onInterrupted?(info?: ChatInterruptedInfo): void | Promise<void>;
}

export interface ChatInterruptedInfo {
  deliversRecoveredReply?: boolean;
}

/**
 * Produces server-authored assistant-message metadata from AI SDK stream parts.
 * Forwarded to the AI SDK `toUIMessageStream` so a Think turn can stamp
 * structured metadata onto the assistant message it persists. Called for every
 * stream part; use `part.type` to choose when to return metadata (`start` and
 * `finish` are the conventional points). Each non-`undefined` return is
 * shallow-merged into the message's metadata. The return value is broadcast to
 * clients and persisted, so it must be
 * JSON-serializable and must not carry server-only secrets.
 *
 * `continuation` is true when the turn continues an earlier one (a recovery
 * continuation or an auto-continue after a tool result). A recovery
 * continuation streams into the interrupted assistant message, so its `start`
 * part cannot overwrite keys that message already has: a `createdAt` stamped
 * on the original `start` survives. Keys the continuation's `start` adds, and
 * everything from later parts, merge as usual.
 *
 * The `Metadata` parameter defaults to the opaque `Record<string, unknown>` used
 * everywhere metadata rides today; it is the seam a future typed-metadata story
 * (issue #1676) narrows without a breaking change.
 */
export type MessageMetadataCallback<
  Metadata extends Record<string, unknown> = Record<string, unknown>
> = (options: {
  part: TextStreamPart<ToolSet>;
  continuation: boolean;
}) => Metadata | undefined;

/**
 * Minimal interface for the result of the inference loop.
 * The AI SDK's `streamText()` result satisfies this interface.
 */
export interface StreamableResult {
  toUIMessageStream(options?: {
    sendReasoning?: boolean;
    onError?: (error: unknown) => string;
  }): AsyncIterable<unknown>;
  output?: PromiseLike<unknown>;
}

/**
 * Options for a chat turn (sub-agent RPC entry point).
 */
export interface ChatOptions {
  signal?: AbortSignal;
  /**
   * Client-defined tool schemas to expose to the model for this turn, mirroring
   * the `clientTools` carried over the WebSocket chat protocol. Use this when a
   * parent agent delegates to a Think sub-agent over RPC but the sub-agent still
   * needs access to tools the client (or parent) defines at runtime.
   *
   * On their own these are execute-less — the model's call surfaces as a tool
   * call through the stream callback. Provide {@link ChatOptions.onClientToolCall}
   * to also resolve those calls inline so the turn can continue to completion.
   */
  clientTools?: ClientToolSchema[];
  /**
   * Executes a client tool call and returns its output, completing the
   * round trip for {@link ChatOptions.clientTools} within the same turn.
   *
   * Without this, a client-tool call has no result and the turn ends with a
   * dangling tool call (the RPC stream callback has no inbound result channel).
   * With it, the model can call a client tool, receive the result, and keep
   * going — the same multi-step behavior the WebSocket path gets from
   * `cf_agent_tool_result` messages.
   */
  onClientToolCall?: ClientToolExecutor;
  /** Channel id this turn belongs to. See {@link RunTurnBase.channel}. */
  channel?: string;
  /**
   * Server-supplied metadata for this turn. Persisted on the turn's user
   * message alongside {@link ChatOptions.channel} (as `metadata.turnMetadata`)
   * so a recovered/continued turn re-resolves it from durable history, and
   * readable during the turn via {@link Think.activeTurnMetadata}.
   *
   * Trust contract mirrors the channel stamp: only server-side callers can set
   * it — reserved metadata keys on client-supplied messages are stripped at
   * intake. This gives messenger/RPC entry points (e.g.
   * {@link Think.chatWithMessengerContext}) a per-turn, recovery-safe carrier
   * for facts like "which authenticated principal initiated this turn" without
   * resorting to mutable agent-wide state.
   */
  metadata?: Record<string, unknown>;
}

/** Input accepted by {@link Think.runTurn}. */
export type TurnInputMessages =
  | string
  | UIMessage
  | UIMessage[]
  | ((current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>);

/** Shared base for {@link RunTurnOptions}; only `input` is common across modes. */
export interface RunTurnBase {
  input?: TurnInputMessages;
  /**
   * Channel id this turn belongs to (resolved against `configureChannels()` /
   * `getMessengers()`). Sets the turn-scoped channel context and is persisted on
   * the user message so a recovered/continued turn re-resolves it. Omit it to
   * run without a channel context. (WebSocket chat turns always run on the
   * implicit `web` channel.)
   */
  channel?: string;
}

/** Options for {@link Think.runTurn} with `mode: "wait"` (the default). */
export interface RunTurnWait extends RunTurnBase {
  mode?: "wait";
  continuation?: boolean;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Options for {@link Think.runTurn} with `mode: "submit"`. */
export interface RunTurnSubmit extends RunTurnBase {
  mode: "submit";
  submissionId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/** Options for {@link Think.runTurn} with `mode: "stream"`. */
export interface RunTurnStream extends RunTurnBase {
  mode: "stream";
  callback: StreamCallback;
  clientTools?: ClientToolSchema[];
  onClientToolCall?: ClientToolExecutor;
  signal?: AbortSignal;
}

export type RunTurnOptions = RunTurnWait | RunTurnSubmit | RunTurnStream;

/** Result of {@link Think.runTurn} in `mode: "wait"`. */
export type TurnResult = SaveMessagesResult & {
  /** Persisted assistant produced by this completed turn; absent otherwise. */
  message?: SessionMessage;
  /**
   * Parsed structured output when the turn's `TurnConfig.output` produced
   * one. A structured output that fails to parse ends the turn with
   * `status: "error"`.
   */
  output?: unknown;
  continuation: boolean;
};

/** What admitted a turn. Exposed on {@link ActiveTurn} and {@link TurnContext}. */
export type TurnTrigger =
  | "ws-chat"
  | "rpc"
  | "programmatic"
  | "submission"
  | "scheduled"
  | "agent-tool"
  | "auto-continuation"
  | "recovery-continue"
  | "recovery-retry";

/** Options for {@link Think.addMessages}. */
export interface AddMessagesOptions {
  /**
   * Parent to attach the first message under. Omitted (`undefined`) attaches to
   * the latest committed leaf at call time; `null` attaches at the root. An
   * explicit id that does not exist throws (fail fast rather than silently
   * misattaching). Subsequent messages in an array chain under the previous one.
   */
  parentId?: string | null;
  /**
   * `"append"` (default) inserts new rows, idempotent by message id.
   * `"upsert"` inserts, or updates in place when the id already exists (in which
   * case `parentId` is ignored — re-parenting is not supported).
   *
   * Idempotency is by id against the whole session tree, not just the target
   * path: if a message id already exists *anywhere* in history, `"append"` is a
   * no-op for it (no new row, no re-parent) and `"upsert"` updates it in place
   * wherever it lives. In both modes the next message in the array chains under
   * that existing id, so passing already-present ids mid-array threads new
   * messages onto the existing branch rather than forking a new one.
   */
  mode?: "append" | "upsert";
  /**
   * Broadcast the change to connected clients. Default `true`. Has no effect
   * when called from inside an active turn (e.g. a tool `execute`), where the
   * live view is intentionally not touched until the next turn's sync.
   */
  broadcast?: boolean;
}

/** Options for {@link Think.deliverNotice}. */
export interface DeliverNoticeOptions {
  /**
   * Target channel id. Defaults to the active turn's channel, else `"web"`.
   */
  channel?: string;
  /**
   * Also record the notice in the model-visible transcript so the next turn
   * knows it was said. Default `false`. For the `web` channel the note is always
   * appended to the transcript (its only render path); `informModel` then only
   * controls the phrasing.
   */
  informModel?: boolean;
  /** Delivery kind for the wire tag. Default `"notice"`. */
  kind?: DeliveryKind;
  /**
   * Conversation/thread hint, required for out-of-turn delivery to a
   * multi-thread messenger channel.
   */
  thread?: string;
}

/** @internal Workflow `step.prompt` settings carried on a turn. */
export type ThinkWorkflowPromptContext = {
  workflow: {
    name: string;
    id: string;
    stepName: string;
    eventType: string;
  };
  output?: {
    schema: unknown;
  };
  fingerprint?: string;
};

/**
 * A chat turn request. Built automatically by each entry path
 * (WebSocket, chat(), saveMessages, auto-continuation) and passed
 * to Think's inference loop.
 */
export interface TurnInput {
  signal?: AbortSignal;
  /** Client-provided tool schemas for dynamic tool registration. */
  clientTools?: ClientToolSchema[];
  /**
   * Executor that resolves client-tool calls inline (RPC `chat()` path). When
   * present, `clientTools` are built WITH an `execute` that delegates to it, so
   * the turn completes the tool round trip itself instead of surfacing a
   * dangling tool call. Not persisted — recovery cannot replay a live executor.
   */
  clientToolExecutor?: ClientToolExecutor;
  /** Custom body fields from the client request. */
  body?: Record<string, unknown>;
  /** Internal workflow prompt configuration, never sourced from client body. */
  workflowPrompt?: ThinkWorkflowPromptContext;
  /** Whether this is a continuation turn (auto-continue after tool result, recovery). */
  continuation: boolean;
}

/**
 * Context passed to the `beforeTurn` hook.
 * Contains everything Think assembled — the hook can inspect and override.
 */
export interface TurnContext {
  /** Assembled system prompt: an overridden `getSystemPrompt()`, then context blocks. */
  system: string;
  /**
   * Assembled model messages (truncated, pruned). When a `whenChanged:
   * "remind"` context block has changed since the prompt froze, its current
   * value rides at the end, inside the last user message when there is one.
   */
  messages: ModelMessage[];
  /** Merged tool set (workspace + getTools + session + MCP + client + caller). */
  tools: ToolSet;
  /**
   * The language model from getModel(), resolved on first read — a
   * `beforeTurn` that returns its own `model` without reading this never
   * resolves the default.
   */
  model: LanguageModel;
  /** Whether this is a continuation turn. */
  continuation: boolean;
  /** Custom body fields from the client request. */
  body?: Record<string, unknown>;
  /**
   * The request this turn runs for: the same id `beforePersist`,
   * `onChatResponse` and `onChatError` see. Undefined for inference that runs
   * outside an admitted turn.
   */
  requestId?: string;
  /** What admitted this turn. Undefined outside an admitted turn. */
  trigger?: TurnTrigger;
  /**
   * Aborts when the turn is cancelled. Pass it to any I/O `beforeTurn` awaits
   * so a stopped turn does not wait for it to finish.
   */
  abortSignal?: AbortSignal;
  /**
   * The messenger thread this turn answers, fixed when the turn was admitted.
   * Unlike {@link Think.getMessengerContext}, it never falls back to another
   * turn's message.
   */
  messenger?: MessengerContext;
}

/**
 * The turn currently running on this agent. See {@link Think.activeTurn}.
 */
export interface ActiveTurn {
  /** Request id shared by every hook, tool call and event of this turn. */
  requestId: string;
  trigger: TurnTrigger;
  continuation: boolean;
  /** Channel the turn resolved to, when it has one. */
  channel?: string;
}

/**
 * Configuration returned by the `beforeTurn` hook to override defaults.
 * All fields are optional — return only what you want to change.
 */
export interface TurnConfig {
  /**
   * Override the model for this turn (e.g. cheap model for continuations).
   * Accepts a model id string (resolved via the built-in provider, same rules
   * as {@link Think.getModel}) or a `LanguageModel`.
   */
  model?: ThinkModel;
  /** Override the assembled instructions prompt. */
  instructions?: string;
  /** @deprecated Prefer `instructions`. */
  system?: string;
  /** Override the assembled messages. */
  messages?: ModelMessage[];
  /** Extra tools to merge (additive — spread on top of existing tools). */
  tools?: ToolSet;
  /** Limit which tools the model can call (AI SDK activeTools). */
  activeTools?: string[];
  /** Force a specific tool call (AI SDK toolChoice). */
  toolChoice?: Parameters<typeof streamText>[0]["toolChoice"];
  /** Override maxSteps for this turn. */
  maxSteps?: number;
  /**
   * Additional AI SDK stop conditions for ending the turn early.
   * Think always keeps its `maxSteps` stop condition as a safety bound.
   */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  /**
   * Controls whether reasoning chunks are included in the UI message stream
   * for this turn. Defaults to the instance-level `sendReasoning` setting.
   */
  sendReasoning?: boolean;
  /**
   * Produces server-authored assistant-message metadata for this turn — the
   * write path that lets a turn attach structured metadata (e.g. a `createdAt`
   * timestamp) to the assistant message Think persists, matching the AI SDK
   * `messageMetadata` callback base `AIChatAgent` + `streamText` already accept.
   * Overrides the instance-level {@link Think.messageMetadata} for this turn.
   * Configure from a Think subclass; sandboxed extensions cannot send functions
   * over RPC. See {@link MessageMetadataCallback} for when it is called and the
   * serialization constraints on its return value.
   */
  messageMetadata?: MessageMetadataCallback;
  /**
   * Override the stream-stall inactivity watchdog timeout for THIS turn only
   * (ms; `0` disables it for this turn). Defaults to the instance-level
   * `chatStreamStallTimeoutMs`. Because the watchdog measures the gap between
   * UI-message-stream chunks — which includes server-side tool execution — a
   * turn known to invoke a slow tool can raise (or disable) the timeout for
   * just that turn instead of permanently widening the global window. Auto-
   * resets after the turn.
   */
  chatStreamStallTimeoutMs?: number;
  /** Maximum number of tokens to generate for this turn. */
  maxOutputTokens?: Parameters<typeof streamText>[0]["maxOutputTokens"];
  /** Temperature setting for this turn. */
  temperature?: Parameters<typeof streamText>[0]["temperature"];
  /** Nucleus sampling setting for this turn. */
  topP?: Parameters<typeof streamText>[0]["topP"];
  /** Top-K sampling setting for this turn. */
  topK?: Parameters<typeof streamText>[0]["topK"];
  /** Presence penalty setting for this turn. */
  presencePenalty?: Parameters<typeof streamText>[0]["presencePenalty"];
  /** Frequency penalty setting for this turn. */
  frequencyPenalty?: Parameters<typeof streamText>[0]["frequencyPenalty"];
  /** Stop sequences for this turn. */
  stopSequences?: Parameters<typeof streamText>[0]["stopSequences"];
  /** Seed for deterministic sampling when supported by the model. */
  seed?: Parameters<typeof streamText>[0]["seed"];
  /** Maximum number of retries for this turn. Set to 0 to disable retries. */
  maxRetries?: Parameters<typeof streamText>[0]["maxRetries"];
  /** Timeout configuration for this turn. */
  timeout?: Parameters<typeof streamText>[0]["timeout"];
  /** Additional HTTP headers for provider requests on this turn. */
  headers?: Parameters<typeof streamText>[0]["headers"];
  /** Provider-specific options (AI SDK providerOptions). */
  providerOptions?: Record<string, unknown>;
  /**
   * Optional AI SDK telemetry configuration for this turn.
   *
   * Typed via the `experimental_telemetry` key, which exists in both AI SDK v6
   * and v7 (`telemetry` is v7-only), so this type resolves under either major.
   */
  telemetry?: Parameters<typeof streamText>[0]["experimental_telemetry"];
  /** @deprecated Prefer `telemetry`. */
  experimental_telemetry?: Parameters<
    typeof streamText
  >[0]["experimental_telemetry"];
  /**
   * Optional AI SDK stream transform(s) for this turn (`experimental_transform`).
   * Forwarded to `streamText` so callers can inspect/rewrite the stream — e.g.
   * detecting tool results that carry `{ content, sources }` and enqueuing
   * additional `source` parts via the transform's controller. Accepts a single
   * transform or an array applied in order.
   */
  experimental_transform?: Parameters<
    typeof streamText
  >[0]["experimental_transform"];
  /**
   * Repairs tool calls that the AI SDK cannot parse or validate before tool
   * execution. The returned tool call is parsed and validated again. Configure
   * this function from a Think subclass; sandboxed extensions cannot send
   * functions over RPC.
   *
   * Typed via the `experimental_repairToolCall` key, which exists in both AI
   * SDK v6 and v7 (`repairToolCall` is v7-only), so this type resolves under
   * either supported major.
   */
  repairToolCall?: Parameters<
    typeof streamText
  >[0]["experimental_repairToolCall"];
  /**
   * Optional structured-output specification (AI SDK `output`).
   * Forwarded to `streamText` so the model's final response is parsed
   * against the supplied schema. Use the AI SDK's `Output.object({ schema })`
   * / `Output.text()` helpers. Combine with `activeTools: []` on the
   * terminal turn if your provider strips tools when structured output
   * is active (e.g. workers-ai-provider).
   */
  output?: Parameters<typeof streamText>[0]["output"];
}

/**
 * Provider-agnostic semantic classification of a chat-turn error.
 *
 * Think ships **no** provider-specific string/code matching — the app owns
 * that knowledge (it knows which provider/model it talks to), exactly like the
 * `tokenCounter` it already passes to `compactAfter()`. An app teaches Think
 * what an error *means* by overriding `classifyChatError()`; Think then reacts
 * generically (e.g. compact-and-retry on `context_overflow`).
 *
 * - `context_overflow` — the prompt exceeded the model's context window
 *   (Anthropic `"prompt is too long"`, OpenAI `context_length_exceeded`, …).
 *   Think compacts and retries when `contextOverflow.reactive` is enabled.
 * - `rate_limit` / `transient` — a stream error worth retrying (a 429, a
 *   dropped connection). Think routes the turn into bounded chat recovery, like
 *   a stream stall, and schedules the continuation with exponential backoff.
 * - `fatal` — unrecoverable; surface terminally.
 * - `unknown` — default; Think applies its existing terminal behavior.
 */
export type ChatErrorClassification =
  | "context_overflow"
  | "rate_limit"
  | "transient"
  | "fatal"
  | "unknown";

/**
 * Opt-in handling for a turn that overflows the model's context window
 * mid-flight. Compaction (`compactAfter()`) is only checked between turns, so a
 * long, tool-heavy turn can grow past the window before the next check; the
 * provider then rejects the request (`"prompt is too long"` /
 * `context_length_exceeded`). Both layers reuse the session's compaction
 * function and are provider-agnostic — the app maps the error via
 * {@link Think.classifyChatError}; Think never matches provider strings itself.
 *
 * Set `Think.contextOverflow` to enable. Leaving it unset disables both layers
 * (existing terminal behavior).
 */
export interface ContextOverflowConfig {
  /**
   * Reactive backstop. When a turn fails with an error classified as
   * `"context_overflow"`, discard the truncated partial, run
   * `session.compact()`, and re-run the turn from the compacted history. The
   * partial is intentionally not persisted: the turn restarts from scratch, so
   * keeping the cut-off assistant message would orphan it beside the recovered
   * answer (and duplicate any tool work the retry re-issues). If compaction
   * cannot shorten history or the retry budget is spent, the overflow surfaces
   * terminally through `onChatError` (classified) — it never loops or ends
   * silently. Default `false`.
   */
  reactive?: boolean;

  /**
   * Maximum compact-and-retry attempts for a single overflowing turn (the
   * reactive backstop). Independent of the proactive guard's cap — see
   * {@link proactive.maxCompactions}. Default `1`.
   */
  maxRetries?: number;

  /**
   * Proactive guard. Before each step, read the previous step's model-reported
   * `usage.inputTokens` and, if it crosses `maxInputTokens * (headroom ?? 0.9)`,
   * compact in place and feed the recompacted history into the upcoming step —
   * heading off the provider rejection before it happens. Keys off usage (every
   * provider reports it), not provider error strings. Unset disables it.
   *
   * If a provider omits `inputTokens`, the guard falls back to `usage.totalTokens`
   * (input + output) — a safe over-approximation that compacts slightly early
   * rather than missing the threshold. If neither is reported, the guard does
   * nothing that step (the reactive backstop still catches a genuine overflow).
   *
   * `maxCompactions` caps how many times the guard may compact within a single
   * step loop (default `1`, floored at `1`). It is independent of
   * {@link maxRetries} (the reactive budget): a no-op compaction would repeat on
   * every step, so the cap stops the guard from compacting (and emitting
   * `chat:context:compacted`) on each one.
   */
  proactive?: {
    maxInputTokens: number;
    headroom?: number;
    maxCompactions?: number;
  };
}

/**
 * Matches the context-window-overflow error messages of the common providers.
 * Anthropic (`prompt is too long`), OpenAI (`context_length_exceeded`,
 * `maximum context length`, `reduce the length of …`), Google Gemini (`exceeds
 * the maximum number of tokens`, `input token count`), Bedrock / Mistral /
 * others (`input is too long`, `too many tokens`, `context window`).
 *
 * This default deliberately favors recall over precision: a missed overflow
 * means no recovery (the feature's whole point), whereas a false positive
 * self-heals — the retry hits the same non-overflow error, the budget is spent,
 * and it surfaces terminally anyway. The vaguest fragment (`reduce the length`)
 * is anchored to `of` to match the real OpenAI phrasing without matching
 * unrelated prose. Apps that need stricter matching can wrap this classifier.
 */
const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|exceeds the maximum number of tokens|input token count|reduce the length of|input is too long|too many (?:input )?tokens|context window/i;

/**
 * Opt-in default classifier for {@link Think.classifyChatError}. Matches the
 * context-window-overflow error messages of the common providers (Anthropic,
 * OpenAI, Google, Bedrock, Mistral, …) and returns `"context_overflow"`.
 *
 * Think ships this as an explicitly-imported helper rather than wiring it into
 * core, so the framework default stays free of provider strings. Assign it (or
 * delegate to it) when you do not need custom classification:
 *
 * @example
 * ```typescript
 * import { Think, defaultContextOverflowClassifier } from "@cloudflare/think";
 *
 * export class MyAgent extends Think<Env> {
 *   override contextOverflow = { reactive: true };
 *   override classifyChatError = defaultContextOverflowClassifier;
 * }
 * ```
 *
 * Or combine with your own checks:
 *
 * @example
 * ```typescript
 * override classifyChatError(error: unknown): ChatErrorClassification | void {
 *   if (isMyRateLimit(error)) return "rate_limit";
 *   return defaultContextOverflowClassifier(error);
 * }
 * ```
 */
export function defaultContextOverflowClassifier(
  error: unknown
): ChatErrorClassification | undefined {
  let text: string;
  if (error instanceof Error) {
    text = error.message;
  } else if (typeof error === "string") {
    text = error;
  } else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
  }
  return CONTEXT_OVERFLOW_PATTERN.test(text) ? "context_overflow" : undefined;
}

export interface ChatErrorContext {
  requestId?: string;
  stage: "parse" | "persist" | "turn" | "stream" | "recovery" | "transcript";
  messagesPersisted?: boolean;
  /**
   * `true` when the failed turn was a server-started continuation (for
   * example after a tool approval or a client tool result) rather than a
   * turn a client or caller submitted.
   */
  continuation?: boolean;
  /**
   * App-provided semantic classification (from `classifyChatError`), when
   * known. Lets `onChatError` overrides and observers distinguish e.g. a
   * context-overflow from a generic provider failure without re-matching
   * provider strings.
   */
  classification?: ChatErrorClassification;
}

/**
 * Context passed to the `beforeStep` hook before each AI SDK step in
 * the agentic loop. Backed by the AI SDK's `PrepareStepFunction<TOOLS>`
 * parameter — exposes the previous `steps`, the zero-based `stepNumber`,
 * the currently selected `model`, the `messages` about to be sent, and
 * `experimental_context`.
 *
 * Pass an explicit `TOOLS` generic for typed previous tool calls / results.
 *
 * Limitations (AI SDK boundary, not Think):
 * - No `abortSignal` is exposed in the context. If you do remote work
 *   inside `beforeStep`, it cannot be cancelled by turn-level abort.
 * - `experimental_context` is typed `unknown`; users must narrow it.
 * - `output` cannot be overridden per-step — set it at the turn level
 *   via `TurnConfig.output` (returned from `beforeTurn`).
 */
export type PrepareStepContext<TOOLS extends ToolSet = ToolSet> = Parameters<
  PrepareStepFunction<TOOLS>
>[0];

/**
 * Configuration returned by `beforeStep` to override defaults for the
 * current AI SDK step. This is the AI SDK's `PrepareStepResult<TOOLS>` —
 * return only the fields you want to override (`model`, `toolChoice`,
 * `activeTools`, `instructions`, `messages`, `experimental_context`,
 * `providerOptions`). The previous `system` field remains available as a
 * deprecated alias.
 *
 * `model` is widened to {@link ThinkModel}: like {@link Think.getModel}, you
 * can return a model id string (resolved via the built-in provider) instead of
 * a `LanguageModel`. Think resolves it before handing the step to the AI SDK.
 */
export type StepConfig<TOOLS extends ToolSet = ToolSet> = Omit<
  PrepareStepResult<TOOLS>,
  "model"
> & {
  model?: ThinkModel;
};

/**
 * Context passed to the `beforeToolCall` hook **before** the tool's
 * `execute` function runs.
 *
 * Backed by the AI SDK's `OnToolCallStartEvent` (the parameter of
 * `experimental_onToolCallStart`). The full `TypedToolCall<TOOLS>`
 * fields (`toolName`, `toolCallId`, `input`, `providerMetadata`, the
 * dynamic/invalid/error discriminators) are spread at the top level for
 * convenience, with the per-call event extras attached:
 *
 * - `stepNumber` — index of the current step
 * - `messages`   — conversation messages visible at tool execution time
 * - `abortSignal` — signal that aborts if the turn is cancelled
 *
 * Pass an explicit `TOOLS` generic for full input typing. With a concrete
 * tool set, narrowing on `ctx.toolName` narrows `ctx.input` to that tool's
 * input shape:
 *
 * ```ts
 * import type { ToolCallContext } from "@cloudflare/think";
 * import type { tools } from "./my-tools";
 *
 * beforeToolCall(ctx: ToolCallContext<typeof tools>) {
 *   if (ctx.toolName === "search") {
 *     ctx.input.query; // typed as string
 *   }
 * }
 * ```
 */
export type ToolCallContext<TOOLS extends ToolSet = ToolSet> =
  PerToolCall<TOOLS> & ToolCallContextExtras;

/** Per-call event extras attached to every {@link ToolCallContext}. */
type ToolCallContextExtras = {
  /** Zero-based index of the current step where this tool call occurs. */
  readonly stepNumber: number | undefined;
  /** The conversation messages available at tool execution time. */
  readonly messages: ReadonlyArray<ModelMessage>;
  /** Signal for cancelling the operation. */
  readonly abortSignal: AbortSignal | undefined;
  /**
   * Request id of the turn making this call, matching `TurnContext.requestId`
   * and `onChatResponse`. Undefined outside an admitted turn.
   */
  readonly requestId?: string;
};

/**
 * The `TypedToolCall<TOOLS>` union, re-keyed so that discriminating on
 * `toolName` narrows `input` per tool.
 *
 * The AI SDK's `TypedToolCall` includes a `DynamicToolCall` arm whose
 * `toolName: string` / `input: unknown` overlaps every static tool name —
 * leaving it in the union collapses `ctx.input` to `unknown` even after a
 * `toolName` check. When an explicit `TOOLS` generic is passed (so the keys
 * are a literal union), we distribute over those keys and drop the dynamic
 * arm so narrowing works. With the default `ToolSet` (keys are `string`) we
 * fall back to the raw union, preserving the prior loose behavior.
 */
type PerToolCall<TOOLS extends ToolSet> = string extends keyof TOOLS
  ? TypedToolCall<TOOLS>
  : {
      [K in keyof TOOLS]: Extract<TypedToolCall<TOOLS>, { toolName: K }>;
    }[keyof TOOLS];

/**
 * Decision returned by `beforeToolCall` to control tool execution.
 * Return void/undefined to allow execution with original input.
 *
 * Discriminated union — each action has a clear, non-overlapping meaning:
 * - `allow` — execute the tool (optionally with modified input)
 * - `block` — don't execute; return `reason` as the tool result so the model can adjust
 * - `substitute` — don't execute; return `output` as the tool result (afterToolCall still fires)
 */
export type ToolCallDecision =
  | {
      action: "allow";
      /** Modified input — tool executes with this instead of the original. */
      input?: Record<string, unknown>;
    }
  | {
      action: "block";
      /** Returned as the tool result so the model can adjust. */
      reason?: string;
    }
  | {
      action: "substitute";
      /** The substitute tool output — model sees this instead of real execution. */
      output: unknown;
      /** Optional input attribution for the afterToolCall log. */
      input?: Record<string, unknown>;
    };

/**
 * Context passed to the `afterToolCall` hook after a tool executes.
 *
 * Backed by the AI SDK's `OnToolExecutionEndEvent`. The full
 * `TypedToolCall<TOOLS>` fields (`toolName`, `toolCallId`, `input`, …) are
 * spread at the top level, plus the per-call event extras:
 *
 * - `stepNumber`  — index of the current step
 * - `messages`    — conversation messages visible at tool execution time
 * - `toolExecutionMs` — wall-clock execution time in milliseconds
 * - `durationMs`  — deprecated alias for `toolExecutionMs`
 * - `toolOutput` — AI SDK v7 discriminated outcome
 * - `success`/`output`/`error` — deprecated normalized outcome aliases:
 *   - on success: `success: true`, `output` typed per tool
 *   - on failure: `success: false`, `error: unknown`
 *
 * Pass an explicit `TOOLS` generic for full input **and** output typing.
 * On the success branch, narrowing on `ctx.toolName` narrows `ctx.output`
 * to that tool's inferred output type (dynamic tools stay `unknown`):
 *
 * ```ts
 * import type { ToolCallResultContext } from "@cloudflare/think";
 * import type { tools } from "./my-tools";
 *
 * afterToolCall(ctx: ToolCallResultContext<typeof tools>) {
 *   if (ctx.toolName === "search" && ctx.success) {
 *     ctx.output.results; // typed as the `search` tool's output
 *   }
 * }
 * ```
 */
export type ToolCallResultContext<TOOLS extends ToolSet = ToolSet> =
  string extends keyof TOOLS
    ? TypedToolCall<TOOLS> & ToolCallResultBase & ToolCallOutcome<unknown>
    : {
        [K in keyof TOOLS]: Extract<TypedToolCall<TOOLS>, { toolName: K }> &
          ToolCallResultBase &
          ToolCallOutcome<InferToolOutput<TOOLS[K]>>;
      }[keyof TOOLS];

/** Per-call extras attached to every {@link ToolCallResultContext}. */
type ToolCallResultBase = {
  readonly stepNumber: number | undefined;
  readonly messages: ReadonlyArray<ModelMessage>;
  /** Wall-clock execution time in milliseconds. */
  readonly toolExecutionMs: number;
  /** @deprecated Prefer `toolExecutionMs`. */
  readonly durationMs: number;
  /** Request id of the turn that made this call; see `ToolCallContext`. */
  readonly requestId?: string;
};

/**
 * The discriminated success/failure outcome of a tool call. On success the
 * `output` is typed (`O`); on failure the `error` is `unknown`.
 */
type ToolCallOutcome<O> =
  | {
      readonly toolOutput: { type: "tool-result"; output: O };
      /** @deprecated Prefer `toolOutput.type === "tool-result"`. */
      readonly success: true;
      /** @deprecated Prefer `toolOutput.output`. */
      readonly output: O;
      readonly error?: never;
    }
  | {
      readonly toolOutput: { type: "tool-error"; error: unknown };
      /** @deprecated Prefer `toolOutput.type === "tool-error"`. */
      readonly success: false;
      readonly output?: never;
      /** @deprecated Prefer `toolOutput.error`. */
      readonly error: unknown;
    };

/**
 * Context passed to the `onStepFinish` hook after each step completes.
 *
 * This is the AI SDK's `StepResult<TOOLS>` (= `OnStepFinishEvent<TOOLS>`) —
 * the full step record including `text`, `reasoning`, `toolCalls`,
 * `toolResults`, `files`, `sources`, `usage` (with `cachedInputTokens`,
 * `reasoningTokens`, `totalTokens`), `finishReason`, `warnings`, `request`,
 * `response`, and `providerMetadata` (where provider-specific cache
 * accounting like `cacheCreationInputTokens` lives).
 *
 * Pass an explicit `TOOLS` generic for typed `toolCalls`/`toolResults`.
 */
export type StepContext<TOOLS extends ToolSet = ToolSet> = Parameters<
  GenerateTextOnStepFinishCallback<TOOLS>
>[0];

/**
 * Context passed to the `onChunk` hook for each streaming chunk.
 *
 * This is the AI SDK's `StreamTextOnChunkCallback` event — `{ chunk }`
 * where `chunk` is a discriminated union of `TextStreamPart` variants
 * (text-delta, reasoning-delta, source, tool-call, tool-input-start,
 * tool-input-delta, tool-result, raw).
 */
export type ChunkContext<TOOLS extends ToolSet = ToolSet> = Parameters<
  StreamTextOnChunkCallback<TOOLS>
>[0];

/**
 * @internal Re-export of the chunk variant union for consumers that need
 * to narrow on `chunk.type` without importing `TextStreamPart` directly.
 */
export type ChunkPart<TOOLS extends ToolSet = ToolSet> =
  ChunkContext<TOOLS>["chunk"];

/**
 * Configuration for a sandboxed extension, returned by getExtensions().
 */
export interface ExtensionConfig {
  /** Extension manifest (name, version, permissions, contributions). */
  manifest: import("./extensions/types").ExtensionManifest;
  /** JavaScript source code defining the extension's tools. */
  source: string;
}

/**
 * @internal The subset of the AI SDK's `ToolExecuteOptions` that Think's
 * tool wrapper reads when resolving a `beforeToolCall` decision.
 */
export type ToolDecisionOptions = {
  toolCallId: string;
  messages: ModelMessage[];
  abortSignal?: AbortSignal;
  context?: unknown;
  experimental_context?: unknown; // v6 alias kept for local wrappers if present
};

/**
 * Keys of the global `AiModels` interface (from `@cloudflare/workers-types`)
 * whose model type extends `T`. Mirrors the derivation `workers-ai-provider`
 * uses, so the set stays in sync with the installed workers-types version.
 */
type WorkersAIModelIdsExtending<T> = {
  [K in keyof AiModels]: AiModels[K] extends T ? K : never;
}[keyof AiModels];

/**
 * A model id accepted by {@link Think.getModel}.
 *
 * Provides editor autocomplete for the Workers AI text-generation catalog
 * (`@cf/...`) while still accepting **any** string — including
 * `"<provider>/<model>"` AI Gateway slugs like `"openai/gpt-5.5"`, whose
 * validity is only known at runtime (the catalog is server-side and changes
 * independently of these types). The `(string & {})` arm is what keeps
 * arbitrary strings assignable without collapsing the autocomplete union.
 */
export type ThinkModelId =
  | Exclude<
      WorkersAIModelIdsExtending<BaseAiTextGeneration>,
      WorkersAIModelIdsExtending<BaseAiTextToImage>
    >
  | (string & {});

/**
 * What {@link Think.getModel} may return: either a fully-constructed AI SDK
 * `LanguageModel`, or a {@link ThinkModelId} string resolved through Think's
 * built-in `workers-ai-provider`. Also the input type of {@link Think.resolveModel}.
 */
export type ThinkModel = LanguageModel | ThinkModelId;
