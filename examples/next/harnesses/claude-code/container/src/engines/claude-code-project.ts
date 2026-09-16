/**
 * The Claude Code projection: SDK messages in, harness frames out.
 *
 * It is a pure function on purpose. The engine owns the process, the query
 * and the permission parks; everything about *what a message means* lives
 * here, so it can be exercised against hand-written fixtures without a
 * model, an API key or a subprocess.
 *
 * The rules it encodes:
 *  - the common cases speak the core vocabulary, so the shared React hook
 *    renders Claude Code the same way it renders every other harness;
 *  - token deltas are previews, never frames;
 *  - anything the projection does not recognise becomes an `engine_raw`
 *    extension rather than a silent drop.
 */
import type {
  HarnessEventBody,
  JsonValue,
  HarnessPreviewBody,
  HarnessSettlement,
  HarnessStopReason,
  HarnessUsage
} from "../../../../shared/src/types.ts";
import type { HarnessWireControl } from "../../../../shared/src/protocol.ts";
import type { ClaudeCodeProtocol } from "../../../src/claude-code-types.ts";

/**
 * The subset of an SDK content block the projection reads. Structural on
 * purpose: the projection imports no SDK type, so a fixture is a plain
 * object and the module stays testable in a bare Node environment.
 */
export type SdkBlock = {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
};

/** The subset of an `SDKMessage` the projection reads. */
export type SdkMessageLike = {
  readonly type: string;
  readonly subtype?: string;
  readonly uuid?: string;
  readonly session_id?: string;
  readonly message?: {
    readonly id?: string;
    readonly role?: string;
    readonly model?: string;
    readonly content?: string | readonly SdkBlock[];
  };
  readonly event?: {
    readonly type?: string;
    readonly message?: { readonly id?: string };
    readonly delta?: {
      readonly type?: string;
      readonly text?: string;
      readonly thinking?: string;
    };
  };
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly compact_metadata?: {
    readonly trigger?: string;
    readonly pre_tokens?: number;
  };
  readonly tool_name?: string;
  readonly tool_use_id?: string;
  readonly new_conversation_id?: string;
  /** On `mirror_error`: which transcript the dropped batch belonged to. */
  readonly key?: {
    readonly projectKey?: string;
    readonly sessionId?: string;
    readonly subpath?: string;
  };
  readonly error?: string;
  readonly rate_limit_info?: {
    readonly status?: string;
    readonly resetsAt?: number;
  };
  readonly attempt?: number;
  readonly max_retries?: number;
  readonly error_status?: number | null;
  readonly task_id?: string;
  readonly duration_ms?: number;
  readonly num_turns?: number;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly errors?: readonly string[];
  readonly stop_reason?: string | null;
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
  readonly modelUsage?: {
    readonly [model: string]: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly thinkingTokens?: number;
      readonly cacheReadInputTokens?: number;
      readonly cacheCreationInputTokens?: number;
      readonly costUSD?: number;
    };
  };
};

/**
 * The parts a `message_end` frame carries. Structurally a
 * `SessionMessagePart`, spelled out here so the projection needs no import
 * from `agents/sessions`.
 */
type MessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: JsonValue;
    };

/** One thing the projection wants written. */
export type ProjectedFrame =
  | {
      readonly kind: "event";
      readonly body: HarnessEventBody<ClaudeCodeProtocol>;
    }
  | {
      readonly kind: "control";
      readonly body: HarnessWireControl<ClaudeCodeProtocol>;
    }
  | { readonly kind: "preview"; readonly body: HarnessPreviewBody };

/** What the engine knows that a single message does not say. */
export type ProjectionContext = {
  /** The turn this message belongs to, or null between turns. */
  readonly operationId: string | null;
  /** An interrupt was requested for this turn, so its result is an abort. */
  readonly interrupted: boolean;
  /** From `Query.interrupt()`, reported verbatim on the settlement. */
  readonly stillQueued: readonly string[];
  /** Assistant message ids that already produced a `message_start`. */
  readonly started: ReadonlySet<string>;
  /** The assistant message the stream is currently delivering. */
  readonly liveMessageId: string | null;
};

/** State the engine folds back in after each message. */
export type ProjectionPatch = {
  readonly started?: string;
  readonly liveMessageId?: string | null;
  readonly engineSessionId?: string;
  readonly settled?: true;
};

export type Projection = {
  readonly frames: readonly ProjectedFrame[];
  readonly patch: ProjectionPatch;
};

const NOTHING: Projection = { frames: [], patch: {} };

function extension(body: ClaudeCodeProtocol["event"]): ProjectedFrame {
  return { kind: "event", body: { type: "extension", body } };
}

/** Project one SDK message. */
export function projectSdkMessage(
  message: SdkMessageLike,
  context: ProjectionContext
): Projection {
  switch (message.type) {
    case "system":
      return projectSystem(message);
    case "assistant":
      return projectAssistant(message, context);
    case "user":
      return projectUser(message);
    case "stream_event":
      return projectStreamEvent(message, context);
    case "result":
      return projectResult(message, context);
    case "conversation_reset":
      // The reset mints a new engine session, so it is reported the same way
      // an init is: the Durable Object must resume the new id, not the old.
      return {
        frames: [
          extension({
            type: "conversation_reset",
            newConversationId: message.new_conversation_id ?? ""
          })
        ],
        patch: {
          ...(message.new_conversation_id === undefined
            ? {}
            : { engineSessionId: message.new_conversation_id })
        }
      };
    case "rate_limit_event":
      return {
        frames: [
          extension({
            type: "rate_limit",
            status: message.rate_limit_info?.status ?? "unknown",
            ...(message.rate_limit_info?.resetsAt === undefined
              ? {}
              : { resetsAt: message.rate_limit_info.resetsAt })
          })
        ],
        patch: {}
      };
    case "command_lifecycle":
      // Per-prompt bookkeeping (queued, started, completed): the harness's
      // own operation_started and operation_settled already say this.
      return NOTHING;
    default:
      return { frames: [engineRaw(message)], patch: {} };
  }
}

function projectSystem(message: SdkMessageLike): Projection {
  switch (message.subtype) {
    case "status":
    case "thinking_tokens":
      // "requesting" on every model call and a running thinking-token
      // estimate: too chatty for a durable log, and status() plus the
      // usage frame already carry what a client needs.
      return NOTHING;
    case "init":
      return {
        frames: [
          extension({
            type: "engine_init",
            sessionId: message.session_id ?? "",
            model: message.model ?? "",
            tools: message.tools ?? []
          })
        ],
        patch: {
          ...(message.session_id === undefined
            ? {}
            : { engineSessionId: message.session_id })
        }
      };
    case "compact_boundary":
      return {
        frames: [
          extension({
            type: "compacted",
            trigger:
              message.compact_metadata?.trigger === "manual"
                ? "manual"
                : "auto",
            preTokens: message.compact_metadata?.pre_tokens ?? 0
          })
        ],
        patch: {}
      };
    case "mirror_error":
      // The SDK gave up on one transcript-mirror batch. The engine keeps
      // running, but the Durable Object is now missing entries a later
      // resume would need, so the loss is reported rather than swallowed.
      return {
        frames: [
          extension({
            type: "mirror_error",
            engineSessionId: message.key?.sessionId ?? "",
            subpath: message.key?.subpath ?? null,
            message: message.error ?? ""
          })
        ],
        patch: {}
      };
    case "permission_denied":
      return {
        frames: [
          extension({
            type: "permission_denied",
            toolCallId: message.tool_use_id ?? "",
            toolName: message.tool_name ?? "",
            reason: message.result ?? message.subtype
          })
        ],
        patch: {}
      };
    case "api_retry":
      return {
        frames: [
          extension({
            type: "retry",
            attempt: message.attempt ?? 0,
            maxRetries: message.max_retries ?? 0,
            errorStatus: message.error_status ?? null
          })
        ],
        patch: {}
      };
    case "task_started":
    case "task_updated":
    case "task_progress":
      return {
        frames: [
          extension({
            type: "subagent",
            state:
              message.subtype === "task_started"
                ? "started"
                : message.subtype === "task_progress"
                  ? "progress"
                  : "ended",
            toolCallId: message.tool_use_id ?? message.task_id ?? ""
          })
        ],
        patch: {}
      };
    default:
      return { frames: [engineRaw(message)], patch: {} };
  }
}

function projectAssistant(
  message: SdkMessageLike,
  context: ProjectionContext
): Projection {
  const messageId = message.message?.id ?? message.uuid ?? "";
  const blocks = blocksOf(message.message?.content);
  const frames: ProjectedFrame[] = [];
  if (!context.started.has(messageId)) {
    frames.push({
      kind: "event",
      body: { type: "message_start", messageId, role: "assistant" }
    });
  }
  const parts = blocks.flatMap<MessagePart>((block) => {
    switch (block.type) {
      case "text":
        return [{ type: "text" as const, text: block.text ?? "" }];
      case "thinking":
        // A redacted or summary-less thinking block has no text to show.
        return block.thinking
          ? [{ type: "reasoning" as const, text: block.thinking }]
          : [];
      case "tool_use":
        return [
          {
            type: "tool-call" as const,
            toolCallId: block.id ?? "",
            toolName: block.name ?? "",
            input: asJson(block.input)
          }
        ];
      default:
        return [];
    }
  });
  frames.push({
    kind: "event",
    body: { type: "message_end", messageId, role: "assistant", parts }
  });
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    frames.push({
      kind: "event",
      body: {
        type: "tool_start",
        toolCallId: block.id ?? "",
        toolName: block.name ?? "",
        input: asJson(block.input)
      }
    });
  }
  return { frames, patch: { started: messageId, liveMessageId: null } };
}

function projectUser(message: SdkMessageLike): Projection {
  const frames: ProjectedFrame[] = [];
  for (const block of blocksOf(message.message?.content)) {
    if (block.type !== "tool_result") continue;
    frames.push({
      kind: "event",
      body: {
        type: "tool_end",
        toolCallId: block.tool_use_id ?? "",
        output: asJson(block.content),
        isError: block.is_error === true
      }
    });
  }
  // A user message with no tool results is the prompt the host just sent; it
  // is already in the transcript, so there is nothing to project.
  return frames.length === 0 ? NOTHING : { frames, patch: {} };
}

function projectStreamEvent(
  message: SdkMessageLike,
  context: ProjectionContext
): Projection {
  const event = message.event;
  if (event?.type === "message_start") {
    const id = event.message?.id;
    return id === undefined
      ? NOTHING
      : { frames: [], patch: { liveMessageId: id } };
  }
  if (event?.type !== "content_block_delta") return NOTHING;
  const messageId = context.liveMessageId ?? message.uuid ?? "";
  const delta = event.delta;
  if (delta?.type === "text_delta" && delta.text !== undefined) {
    return {
      frames: [
        {
          kind: "preview",
          body: { type: "text_delta", messageId, delta: delta.text }
        }
      ],
      patch: {}
    };
  }
  if (delta?.type === "thinking_delta" && delta.thinking !== undefined) {
    return {
      frames: [
        {
          kind: "preview",
          body: { type: "reasoning_delta", messageId, delta: delta.thinking }
        }
      ],
      patch: {}
    };
  }
  return NOTHING;
}

function projectResult(
  message: SdkMessageLike,
  context: ProjectionContext
): Projection {
  if (context.operationId === null)
    return { frames: [engineRaw(message)], patch: {} };
  const usage = usageOf(message);
  const settlement = settlementOf(message, context, usage);
  return {
    frames: [
      { kind: "event", body: { type: "usage", usage } },
      {
        kind: "control",
        body: { type: "settle", operationId: context.operationId, settlement }
      }
    ],
    patch: { settled: true, liveMessageId: null }
  };
}

/** The settlement one `result` message implies. Exported for the tests. */
export function settlementOf(
  message: SdkMessageLike,
  context: ProjectionContext,
  usage: HarnessUsage
): HarnessSettlement<ClaudeCodeProtocol> {
  const subtype = message.subtype ?? "unknown";
  const raw: ClaudeCodeProtocol["result"] = {
    subtype,
    ...(message.duration_ms === undefined
      ? {}
      : { duration_ms: message.duration_ms }),
    ...(message.num_turns === undefined
      ? {}
      : { num_turns: message.num_turns }),
    ...(message.is_error === undefined ? {} : { is_error: message.is_error })
  };
  const base = {
    usage,
    raw,
    ...(context.stillQueued.length === 0
      ? {}
      : { stillQueued: context.stillQueued })
  };
  if (context.interrupted) {
    return {
      ...base,
      status: "aborted",
      stopReason: { type: "interrupted" }
    };
  }
  if (subtype === "success" && message.is_error !== true) {
    return {
      ...base,
      status: "completed",
      stopReason: stopReasonOf(message.stop_reason ?? null)
    };
  }
  const stopReason: HarnessStopReason =
    subtype === "error_max_turns"
      ? { type: "max_turns" }
      : subtype === "error_max_budget_usd"
        ? { type: "budget" }
        : { type: "error", raw: subtype };
  return {
    ...base,
    status: "failed",
    stopReason,
    error: { code: subtype, message: errorMessageOf(message) }
  };
}

function errorMessageOf(message: SdkMessageLike): string {
  if (message.errors !== undefined && message.errors.length > 0) {
    return message.errors.join("; ");
  }
  if (typeof message.result === "string" && message.result !== "") {
    return message.result;
  }
  return message.subtype ?? "The engine failed";
}

function stopReasonOf(stopReason: string | null): HarnessStopReason {
  switch (stopReason) {
    case null:
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
      return { type: "end_turn" };
    case "max_tokens":
      return { type: "max_tokens" };
    case "refusal":
      return { type: "refusal" };
    default:
      return { type: "other", raw: stopReason };
  }
}

/**
 * Token and cost totals. `modelUsage` covers subagents and compaction and is
 * the field to account from; the per-turn `usage` is the fallback when a
 * result carries no model breakdown.
 */
export function usageOf(message: SdkMessageLike): HarnessUsage {
  const models = Object.values(message.modelUsage ?? {});
  if (models.length > 0) {
    const sum = (
      pick: (entry: (typeof models)[number]) => number | undefined
    ) => models.reduce((total, entry) => total + (pick(entry) ?? 0), 0);
    return {
      inputTokens: sum((entry) => entry.inputTokens),
      outputTokens: sum((entry) => entry.outputTokens),
      reasoningTokens: sum((entry) => entry.thinkingTokens),
      cacheReadTokens: sum((entry) => entry.cacheReadInputTokens),
      cacheWriteTokens: sum((entry) => entry.cacheCreationInputTokens),
      costUsd: message.total_cost_usd ?? sum((entry) => entry.costUSD)
    };
  }
  return {
    inputTokens: message.usage?.input_tokens ?? 0,
    outputTokens: message.usage?.output_tokens ?? 0,
    cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
    ...(message.total_cost_usd === undefined
      ? {}
      : { costUsd: message.total_cost_usd })
  };
}

function engineRaw(message: SdkMessageLike): ProjectedFrame {
  return extension({
    type: "engine_raw",
    kind: message.type,
    subtype: message.subtype ?? null,
    body: asJson(message)
  });
}

function blocksOf(
  content: string | readonly SdkBlock[] | undefined
): readonly SdkBlock[] {
  if (content === undefined) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

/** Everything the SDK hands back arrived as JSON, so this is a re-label. */
function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
