/**
 * Think — an opinionated chat agent base class.
 *
 * Works as both a **top-level agent** (speaking the `cf_agent_chat_*`
 * WebSocket protocol to browser clients) and a **sub-agent** (called
 * via `chat()` over RPC from a parent agent).
 *
 * Each instance holds one conversation in its own SQLite storage, backed by
 * Sessions — providing tree-structured messages, context blocks, compaction,
 * and FTS5 search.
 *
 * Configuration overrides:
 *   - getModel()            — return a model id string (resolved via the
 *                             built-in workers-ai-provider) or a LanguageModel
 *   - getSystemPrompt()     — instructions at the top of the system prompt
 *   - getTools()            — return the ToolSet for the agentic loop
 *   - maxSteps              — max tool-call rounds per turn (default: 10)
 *   - configureSession()    — compaction and search policy
 *   - configureContext()    — declare prompt context blocks
 *
 * Lifecycle hooks:
 *   - beforeTurn()          — inspect/override context, tools, model before inference
 *   - beforeStep()          — per-step callback to override model, messages, tool selection
 *   - beforeToolCall()      — intercept tool calls (block, modify args, substitute result)
 *   - afterToolCall()       — inspect tool results after execution
 *   - onStepFinish()        — per-step callback (logging, analytics)
 *   - onChunk()             — per-chunk callback (streaming analytics)
 *   - onChatResponse()      — post-turn lifecycle hook (logging, chaining, analytics)
 *   - onChatError()         — customize error handling
 *
 * Production features:
 *   - WebSocket chat protocol (compatible with useAgentChat / useChat)
 *   - Sub-agent RPC streaming via StreamCallback
 *   - Session-backed storage with tree-structured messages
 *   - Context blocks with LLM-writable persistent memory
 *   - Non-destructive compaction (summaries replace ranges at read time)
 *   - FTS5 full-text search across conversation history
 *   - Abort/cancel support via AbortRegistry
 *   - Error handling with partial message persistence
 *   - Message sanitization (strips OpenAI ephemeral metadata)
 *   - Row size enforcement (compacts large tool outputs)
 *   - Resumable streams (replay on reconnect)
 *
 * @experimental The API surface may change before stabilizing.
 *
 * @example
 * ```typescript
 * import { Think } from "@cloudflare/think";
 *
 * export class MyAgent extends Think<Env> {
 *   getModel() {
 *     // A string is resolved via the built-in workers-ai-provider off env.AI.
 *     // Use a "@cf/..." id for Workers AI, or a "provider/model" slug like
 *     // "openai/gpt-5.5" to route through AI Gateway.
 *     return "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
 *   }
 *
 *   getSystemPrompt() {
 *     return "You are a helpful coding assistant.";
 *   }
 * }
 * ```
 *
 * @example With context blocks and self-updating memory
 * ```typescript
 * import { Think } from "@cloudflare/think";
 * import type { ContextConfig } from "agents/context";
 *
 * export class MemoryAgent extends Think<Env> {
 *   getModel() { ... }
 *
 *   configureContext(): ContextConfig[] {
 *     return [
 *       {
 *         label: "soul",
 *         provider: { get: async () => "You are a helpful coding assistant." }
 *       },
 *       {
 *         label: "memory",
 *         description: "Important facts learned during conversation.",
 *         maxTokens: 2000
 *       }
 *     ];
 *   }
 * }
 * ```
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModel, ModelMessage, ToolSet, UIMessage } from "ai";
import {
  toDeclaredSchedules,
  type ThinkScheduledTasks
} from "./scheduled-tasks";
import {
  deliverChannelNotice,
  resolveChannelContext,
  type ChannelEvent
} from "./channels/runtime";
import {
  DEFAULT_ACTION_TIMEOUT_MS,
  actionApprovalInputErrorEnvelope,
  actionContextWithoutReply,
  actionErrorEnvelope,
  approvedActionInputs,
  compileActionTools,
  createActionAbortSignal,
  normalizeActionAuthorization,
  prepareActionOutputForModel,
  safeStringifyActionOutput,
  type ActionToolHost
} from "./action-tools";
import { defaultAttachmentText, deliverReplyAttachments } from "./attachments";
import {
  isAction,
  type Action,
  type ActionApprovalDescriptor,
  type ActionAuthorizationContext,
  type ActionAuthorizationDecision,
  type ActionContext,
  type ActionIdempotencyKey,
  type CompiledActionMetadata,
  type NormalizedActionAuthorization,
  type ReplyAttachment
} from "./actions";
import { ThinkConfigStore } from "./config-store";
import { wrapToolsWithDecision } from "./tool-decision";
import {
  ThinkContextOverflow,
  isTransientClassification
} from "./context-overflow";
import {
  EXECUTION_OUTCOME_MESSAGE_PREFIX,
  MODEL_TRUNCATION_STEP,
  ensureValidContinueCheckpoint,
  modelMessagesFromHistory,
  withContextReminder
} from "./inference/model-messages";
import { withoutFinalAnswerParts } from "./inference/structured-output";
import type { TelemetryIdentity } from "./inference/telemetry";
import {
  createInferenceInvocation,
  drainInferenceStream
} from "./inference/invocation";
import { MessengerReplies } from "./messengers/reply-task";
import { ThinkModelResolver } from "./model";
import {
  ThinkTranscriptCache,
  cachedMessageBytes,
  type HydrationResult
} from "./transcript-cache";
import { declaredOverrides } from "./overrides";
import {
  RESERVED_MESSAGE_METADATA_KEYS,
  channelFromMessages,
  incomingMessageWrite,
  stampTurnContext,
  turnMetadataFromMessages
} from "./turn-metadata";
import { ThinkSkills } from "./skills-runtime";
import { systemPromptForTurn } from "./system-prompt";
import * as skills from "./skills";
import type { SkillScriptRunner, SkillSource } from "agents/skills";

// Re-export AI SDK types that appear on Think's public lifecycle hooks
// so users can import them from a single place.
export type {
  PrepareStepFunction,
  PrepareStepResult,
  StepResult,
  StopCondition,
  TextStreamPart,
  TypedToolCall,
  TypedToolResult
} from "ai";
export { skills };
export type {
  Skill,
  SkillCatalog,
  SkillRunContext,
  SkillSource
} from "agents/skills";
import {
  Agent,
  callable,
  getCurrentAgent,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  __DO_NOT_USE_WILL_BREAK__withInvocationScope as withInvocationScope
} from "agents";

import type {
  AgentToolLifecycleResult,
  AgentToolMilestone,
  AgentToolProgress,
  AgentToolEventDelivery,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolStoredChunk,
  Connection,
  FiberRecoveryContext,
  RetryOptions,
  SubAgentClass,
  WSMessage
} from "agents";
import { declareSchedules } from "agents/internal";
import {
  sanitizeMessage,
  enforceRowSizeLimit,
  CHAT_MESSAGE_TYPES,
  ChatFrames,
  ResumableStream,
  createChatStreams,
  addContinuationTarget,
  ChatTurns,
  ChatTurnFibers,
  createChatAdmissionStore,
  newUserMessageIds,
  clientResolvableToolNames,
  chatRecoveryNames,
  type ChatAdmissionRecord,
  type ClientChatRequest,
  pinnedOr,
  type PinnedTurnContext as PinnedContext,
  prepareTurnMessages,
  type ServerChatTurn,
  toSaveMessagesResult,
  type ServerTurnStatus,
  type ToolInteractionOutcome,
  type ToolPartUpdate,
  AgentToolRuns,
  abortReasonText,
  createAgentToolRunStore,
  createToolsFromClientSchemas,
  applyToolPartUpdate,
  applyToolUpdate,
  unexecutedToolNames,
  toolResultUpdate,
  toolApprovalUpdate,
  pausedExecutionUpdate,
  ChatRequestContext,
  dispatchChatProtocol,
  rejectionMessage,
  releaseChatConnection,
  type ChatProtocolHost,
  type ParsedChatRequest,
  aiSdkRecoveryCodec,
  ResumeHandshake,
  normalizeToolInput,
  interruptedToolPartAsError,
  unsettledToolCallIds,
  streamChunksFinished,
  persistReconstructedOrphan,
  keepStoredReplies,
  reconcileMessages,
  CHAT_RECOVERY_TASK_NAME,
  chatRecoveryProgressReader,
  chatRecoveryStorageAdapter,
  createChatRecoveryTaskDefinition,
  createChatTurnTaskDefinition,
  enqueueChatRecoveryTask,
  clearRecentChatTerminals,
  recentChatTerminal,
  type StreamInterruptionOutcome,
  createChatFiberSnapshot,
  unwrapChatFiberSnapshot,
  MAX_BOUND_PARAMS,
  buildInClauseStrings,
  resolveChatRecoveryConfig,
  ChatRecoveryEngine,
  runChatRecoveryExhaustion,
  retryAfterSeconds,
  isDurableObjectResetError,
  isTurnStopped,
  CHAT_RECOVERY_PROGRESS_KEY,
  recordChatTerminal,
  clearChatTerminal,
  pendingChatTerminal,
  originMessageIds,
  buildChatRecoveringFrame,
  setChatRecovering,
  AgentToolStreamProgressThrottle,
  type ChatRecoveryAdapter,
  type ChatFiberWakeHooks,
  type ResolvedRecoveryStream,
  type ClassifyRecoveredTurnInput,
  type DispatchRecoveredTurnInput,
  type ChatRecoveryScheduleCallback,
  type ChatRecoveryTaskReason,
  CHAT_RECOVERY_INCIDENT_KEY_PREFIX,
  type ChatRecoveryAttemptScope,
  type ChatRecoveryIncident,
  type ChatRecoveryKind
} from "agents/chat";
import type { Streams } from "agents/streams";
import {
  Approvals,
  stableHash,
  stableStringify,
  type EffectOutcome
} from "agents/internal";
import type {
  ContinuationTurn,
  RecoveryLeafCheck,
  ReplyRemoval,
  TurnFailureHost
} from "agents/chat";
import {
  replyIsEmpty,
  settleInterruptedPart,
  stripTrailingReasoning
} from "agents/chat";
import type {
  BeforeTurnRepairResult,
  RepairedTranscriptSink,
  StreamChunkData,
  ClientToolSchema,
  ClientToolExecutor,
  MessagePart,
  ChatFiberSnapshot,
  OrphanPersistStore
} from "agents/chat";
import {
  pumpReply,
  ReplyStreams,
  streamErrorText,
  TransientChatStreamError,
  uiMessageStreamSource,
  type ReplyPumpHost,
  type ReplyResult
} from "agents/chat";
import {
  Sessions,
  isCompactionMessage,
  type SessionMessage
} from "agents/sessions";
import { ThinkSession } from "./session";
import {
  AgentContextProvider,
  ContextBlocks,
  type ContextConfig,
  type WritableContextProvider
} from "agents/context";

/** Copy a turn context without reading its lazily resolved `model`. */
function turnContextWithoutModel(ctx: TurnContext): Omit<TurnContext, "model"> {
  const { model: _model, ...descriptors } =
    Object.getOwnPropertyDescriptors(ctx);
  return Object.defineProperties({}, descriptors) as Omit<TurnContext, "model">;
}

const MAX_REPLY_ATTACHMENTS_PER_TURN = 32;
const DEFERRED_RESOLVED_PAUSES_KEY = "cf_think_deferred_resolved_pauses";
const PENDING_RESPONSE_HOOK_PREFIX = "cf_think_pending_response_hook:";
const MESSENGER_RECOVERY_PREFIX = "cf_think_messenger_recovery:";

/**
 * A messenger reply this agent owes after chat recovery settles, keyed by the
 * recovery incident. `outcome` is set once the incident settles, so a reset
 * between settling and posting re-delivers on the next start.
 */
type MessengerRecoveryDelivery = {
  messengerId: string;
  threadId: string;
  partialText: string;
  outcome?: "completed" | "interrupted";
  text?: string;
  /**
   * Posts of the reply already attempted. Advanced before each post, so a
   * reset mid-post resumes after it rather than posting it twice.
   */
  posted?: number;
};

const MESSENGER_RECOVERY_RETRY_CALLBACK = "_cfRetryMessengerRecoveryDelivery";
const MESSENGER_RECOVERY_MAX_RETRIES = 8;

function messageText(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function settleMessengerRecoveryDelivery(
  delivery: MessengerRecoveryDelivery,
  outcome: "completed" | "interrupted",
  text?: string
): MessengerRecoveryDelivery {
  if (outcome !== "completed") return { ...delivery, outcome };
  const recovered = text ?? "";
  return {
    ...delivery,
    outcome,
    text: recovered.startsWith(delivery.partialText)
      ? recovered.slice(delivery.partialText.length)
      : recovered
  };
}

type PendingResponseHook = {
  requestId: string;
  messageId: string;
  continuation: boolean;
  status: ChatResponseResult["status"];
  error?: string;
};

/** A live stream interruption (stall or transient error) to route to recovery. */
type StreamInterruptionRoute = {
  requestId: string;
  streamId: string;
  partialParts: MessagePart[];
  persistPartial: () => Promise<string | undefined>;
  /** The user message a regeneration answers as a new sibling branch. */
  branchParentId?: string;
  /** Delay the continuation with exponential backoff (transient errors). */
  backoff?: boolean;
  /** The error that interrupted the stream. */
  error: unknown;
  /** The app said `persist: false`: the turn must not store the partial. */
  onPartialDropped: () => void;
  /** A provider `Retry-After` the engine cannot read from `error` itself. */
  retryAfterSeconds?: number;
};

type ResolvedPauseOutcome = { executionId: string; output: unknown };

function isPausedToolPart(part: Record<string, unknown>): boolean {
  const output = part.output as { status?: unknown } | null | undefined;
  return (
    part.state === "output-available" &&
    output != null &&
    typeof output === "object" &&
    output.status === "paused"
  );
}

function ownsPausedToolCall(message: UIMessage, toolCallId: string): boolean {
  return (message.parts as unknown as Array<Record<string, unknown>>).some(
    (part) => part.toolCallId === toolCallId && isPausedToolPart(part)
  );
}

/** The tool call id of a part whose output carries `executionId`, if any. */
function executionToolCallIn(
  message: UIMessage,
  executionId: string,
  pausedOnly: boolean
): string | null {
  if (message.role !== "assistant") return null;
  for (const part of message.parts as unknown as Array<
    Record<string, unknown>
  >) {
    if (part.state !== "output-available") continue;
    if (typeof part.toolCallId !== "string") continue;
    const output = part.output as
      | { status?: unknown; executionId?: unknown }
      | null
      | undefined;
    if (
      output != null &&
      typeof output === "object" &&
      (!pausedOnly || output.status === "paused") &&
      output.executionId === executionId
    ) {
      return part.toolCallId;
    }
  }
  return null;
}

/**
 * A client that missed a pause's resolution resubmits its part still paused,
 * and reconciliation protects server results only from pre-output client
 * states. Keep the server's resolved part, and drop the pending-state text
 * after it as the resolution did.
 *
 * Providers may reuse a toolCallId across turns, so the resolution is taken
 * only from the server row the message reconciled to; a pause still pending
 * there stays pending. A resolution on any other row can belong to another
 * turn.
 */
function keepResolvedPauses(
  incoming: UIMessage[],
  serverMessages: readonly UIMessage[]
): UIMessage[] {
  type Part = UIMessage["parts"][number];
  const resolvedByMessage = new Map<string, Map<string, Part>>();
  for (const message of serverMessages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      const record = part as Record<string, unknown>;
      if (
        typeof record.toolCallId === "string" &&
        (record.state === "output-available" ||
          record.state === "output-error" ||
          record.state === "output-denied") &&
        !isPausedToolPart(record)
      ) {
        let own = resolvedByMessage.get(message.id);
        if (!own) {
          own = new Map();
          resolvedByMessage.set(message.id, own);
        }
        own.set(record.toolCallId, part);
      }
    }
  }
  if (resolvedByMessage.size === 0) return incoming;

  return incoming.map((message) => {
    if (message.role !== "assistant") return message;
    const own = resolvedByMessage.get(message.id);
    if (!own) return message;
    const stale = new Map<string, Part>();
    for (const part of message.parts) {
      const record = part as Record<string, unknown>;
      if (typeof record.toolCallId !== "string" || !isPausedToolPart(record)) {
        continue;
      }
      const server = own.get(record.toolCallId);
      if (server) stale.set(record.toolCallId, server);
    }
    if (stale.size === 0) return message;
    let parts = message.parts;
    for (const [toolCallId, server] of stale) {
      parts = dropGenerationAfterToolCall(
        parts.map((part) =>
          "toolCallId" in part && part.toolCallId === toolCallId ? server : part
        ),
        toolCallId
      );
    }
    return { ...message, parts };
  });
}

const ACTION_PENDING_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const ACTION_PENDING_LAST_SWEPT_KEY =
  "cf_think_action_pending_approvals:last_swept_at";
/** Prefix for durable-pause action execution ids (vs codemode execution ids). */
const ACTION_PAUSE_ID_PREFIX = "actpause_";
import { Workspace, type WorkspaceStub } from "@cloudflare/computer";
import { createAITools } from "@cloudflare/computer/tools/ai-sdk";
import {
  WorkspaceFiles,
  isLocalWorkspace,
  type ThinkWorkspace
} from "./workspace-files";
import {
  MediaEvictionPasses,
  resolveMediaEvictionConfig,
  type MediaEvictionConfig,
  type MediaEvictionPassResult
} from "./media-eviction";
import { createFetchTools } from "./tools/fetch";
import type { CreateFetchToolsOptions, FetchToolEvent } from "./tools/fetch";
import { truncatePausedExecutionOutput } from "./tools/execute";
import {
  callThinkHostApi,
  createThinkHostApi,
  type ThinkHostApi,
  type ThinkHostOperation
} from "./extensions/host-api";
import {
  ThinkExtensionHooks,
  createThinkExtensionManager,
  loadThinkExtensions
} from "./extensions/pipeline";
import { ThinkMessengerRuntime } from "./messengers/chat-sdk";
import { DEFAULT_MESSENGER_CONCURRENCY } from "./messengers";
import type {
  MessengerConcurrency,
  MessengerContext,
  MessengerDeliverySurface,
  ThinkMessengers,
  MessengerThinkHost
} from "./messengers";
import { resolveChannels } from "./channels";
import type {
  ChannelContext,
  NormalizedChannelDefinition,
  ThinkChannels
} from "./channels";

export { messengerChannel } from "./channels";
export type {
  ChannelCapabilities,
  ChannelContext,
  ChannelDefinition,
  ChannelDeliveryPolicy,
  ChannelDeliverySurface,
  ChannelIngress,
  ChannelKind,
  NormalizedChannelDefinition,
  ThinkChannels
} from "./channels";
export type { DeliveryKind, DeliveryTag } from "./messengers";
export { ThinkSession, ThinkSession as Session } from "./session";
export type {
  CompactAfterOptions,
  CompactionErrorHandler,
  SessionContextOptions
} from "./session";
export type { SessionMessage } from "agents/sessions";
export type { FiberContext, FiberRecoveryContext } from "agents";
export type {
  ThinkIntervalSchedule,
  ThinkScheduledTask,
  ThinkScheduledTaskContext,
  ThinkScheduledTasks,
  ThinkScheduledTaskSchedule,
  ThinkTime,
  ThinkWallClockSchedule
} from "./scheduled-tasks";
export type {
  ThinkWorkspace,
  ThinkWorkspaceFilesystem
} from "./workspace-files";

export type {
  CreateFetchToolsOptions,
  FetchBindingTarget,
  FetchResult,
  FetchToolEvent,
  FetchErrorCode,
  FetchResponseMode,
  FetchRedirectPolicy
} from "./tools/fetch";

// ── Wire protocol constants ────────────────────────────────────────
const MSG_CHAT_MESSAGES = CHAT_MESSAGE_TYPES.CHAT_MESSAGES;
const MSG_CHAT_RESPONSE = CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
const MSG_CHAT_CLEAR = CHAT_MESSAGE_TYPES.CHAT_CLEAR;
const MSG_MESSAGE_UPDATED = CHAT_MESSAGE_TYPES.MESSAGE_UPDATED;
const MSG_CHAT_RECOVERING = CHAT_MESSAGE_TYPES.CHAT_RECOVERING;

function stableJsonEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function actionPendingErrorEnvelope(): {
  error: { name: string; message: string };
} {
  return {
    error: {
      name: "ActionPendingError",
      message:
        "A prior attempt of this action is in an unknown state; not re-executed. Manual reconciliation may be required."
    }
  };
}

function actionKeyConflictEnvelope(
  actionName: string,
  key: string
): {
  error: { name: string; message: string };
} {
  return {
    error: {
      name: "ActionKeyConflict",
      message: `Idempotency key "${key}" for action "${actionName}" was reused with different input. This is a programming error; do not retry.`
    }
  };
}

type StreamResultStatus = {
  status: Exclude<SaveMessagesResult["status"], "skipped">;
  error?: string;
  /** `"interrupted"` for a reply cut off and handed to recovery. */
  reason?: SaveMessagesResult["reason"];
  output?: unknown;
};

type ProgrammaticMessagesResult = SaveMessagesResult & {
  output?: unknown;
};

type PinnedTurnContext = PinnedContext<ClientToolSchema>;

function withOutput(output: unknown): { output?: unknown } {
  return output !== undefined ? { output } : {};
}

type ChatRecoveryRetryData = {
  targetUserId?: string;
  /**
   * Set when the interrupted turn regenerated `targetUserId`: the leaf the new
   * response branches beside. The retry answers `targetUserId` as a sibling
   * branch, and only while this is still the leaf.
   */
  regeneratedLeafId?: string;
  originalRequestId?: string;
  incidentId?: string;
  originMessageIds?: string[];
  lastBody?: Record<string, unknown> | null;
  lastClientTools?: ClientToolSchema[] | null;
  recoveredRequestId?: string;
};

type ChatRecoveryContinueData = {
  targetAssistantId?: string;
  originalRequestId?: string;
  incidentId?: string;
  originMessageIds?: string[];
  lastBody?: Record<string, unknown> | null;
  lastClientTools?: ClientToolSchema[] | null;
  recoveredRequestId?: string;
};

/**
 * Think's chat fiber snapshot. `branchParentId` is set for a regeneration: the
 * user message the turn answers as a new sibling branch.
 */
type ThinkChatFiberSnapshot = ChatFiberSnapshot<"think-chat-turn"> & {
  branchParentId?: string;
};

function regenerationParentOf(
  snapshot: ChatFiberSnapshot | null
): string | undefined {
  const parentId = (snapshot as ThinkChatFiberSnapshot | null)?.branchParentId;
  return typeof parentId === "string" ? parentId : undefined;
}

/**
 * `Think`'s `classifyRecoveredTurn` detail (the {@link ChatFiberWakeHooks}
 * generic). `retryTargetUserId` is the pre-stream user message the turn re-runs
 * when it had no partial; the dispatch decision re-derives `streamIsTerminal` from
 * `streamStatus` rather than carrying it here.
 */
type ThinkRecoveryClassification = { retryTargetUserId: string | null };

// `ChatRecoveryIncident` / `ChatRecoveryKind` / `CHAT_RECOVERY_INCIDENT_KEY_PREFIX`
// are the canonical shared symbols from `agents/chat` (imported above); the
// persisted incident shape and key prefix are owned by the engine package so
// both consumers round-trip the same record across the deploy that ships them.

// The monotonic forward-progress marker the recovery budget keys off is
// derived from the stream log (`ResumableStream.progressMarker`): durably
// flushed segments, folded into a retired total as their rows are deleted.
// Nothing is written per chunk. The pre-derivation KV counter
// (`CHAT_RECOVERY_PROGRESS_KEY`) is read once per isolate and seeded into the
// marker, so it is never read lower than an in-flight incident recorded.
// Recovery budget defaults (maxAttempts, maxRecoveryWork, stableTimeoutMs,
// terminalMessage, noProgressTimeoutMs, alarm debounce) now live in the shared
// incident engine (agents/chat) and are applied by `resolveChatRecoveryConfig`
// / `evaluateChatRecoveryIncident`. See design/rfc-chat-recovery-foundation.md.
// Auto-continuation barrier (#1649 / #1650): when the model emits parallel tool
// calls, the client answers each one independently and sends a `tool-result`
// with `autoContinue` per result. A fast tool's result must NOT trigger
// inference while a slower sibling is still `input-available` — doing so feeds
// the provider an incomplete tool-result set (MissingToolResultsError) or, with
// the transcript-repair backstop, silently flips the in-flight sibling to
// errored and runs a spurious extra continuation. So we hold the continuation
// until the step's batch settles (no `input-available`/`approval-requested`
// siblings).
//
// The barrier is event-driven (#1650): auto-continuation is only ever triggered
// by a tool-result/approval event, so instead of waiting on a fixed timer we
// drain the in-flight applies, re-check, and — if a sibling is still unanswered
// — simply return, leaving the pending continuation in place. The next sibling's
// result re-arms the coalesce timer (or, after eviction, re-creates the pending
// state from the persisted transcript) and re-runs the check; the continuation
// fires once the final sibling lands. This means a legitimately slow answer (a
// human-in-the-loop tool with no `execute`, an unbounded RPC) never fires
// through to a spurious error, and a true orphan (a sibling that never arrives)
// simply never auto-continues — the isolate is not pinned waiting for it.
// (Stable-state retry delay `CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS` and the
// incident sweep — TTL selection, key prefix, and batched delete — now live in
// agents/chat; the reschedule is owned by the shared engine and the sweep by the
// shared `sweepStaleChatRecoveryIncidents` helper.)
// (The recovering-flag key/TTL and the stream-cleanup delay/re-arm loop now live
// in agents/chat — the durable recovery UX is driven via the shared
// `setChatRecovering` / `buildChatRecoveringFrame` helpers, and buffer cleanup via
// The N9 throttle lives
// there too as `AgentToolStreamProgressThrottle`.)

// (The terminal-record key and the recovering-flag key now live in agents/chat;
// the durable terminal/recovering records are driven via the shared
// `recordChatTerminal` / `clearChatTerminal` / `pendingChatTerminal` /
// `setChatRecovering` / `buildChatRecoveringFrame` helpers.)

export type { MediaEvictionConfig } from "./media-eviction";
export { action, isAction } from "./actions";
export type {
  Action,
  ActionApprovalDescriptor,
  ActionApprovalPolicy,
  ActionAuthorizationContext,
  ActionAuthorizationDecision,
  ActionConfig,
  ActionContext,
  ActionIdempotencyKey,
  ActionKind,
  ActionPermissionSpec,
  ReplyAttachment
} from "./actions";
export { defaultContextOverflowClassifier } from "./turn-types";
export type {
  ActiveTurn,
  AddMessagesOptions,
  ChatErrorClassification,
  ChatErrorContext,
  ChatInterruptedInfo,
  ChatOptions,
  ChatStartEvent,
  ChunkContext,
  ChunkPart,
  ContextOverflowConfig,
  DeliverNoticeOptions,
  ExtensionConfig,
  MessageMetadataCallback,
  OnStartDegradation,
  PrepareStepContext,
  RunTurnBase,
  RunTurnOptions,
  RunTurnStream,
  RunTurnSubmit,
  RunTurnWait,
  StepConfig,
  StepContext,
  StreamCallback,
  StreamableResult,
  ThinkModel,
  ThinkModelId,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  TurnConfig,
  TurnContext,
  TurnInput,
  TurnInputMessages,
  TurnResult,
  TurnTrigger
} from "./turn-types";
import type {
  ActiveTurn,
  AddMessagesOptions,
  ChatErrorClassification,
  ChatErrorContext,
  ChatOptions,
  ChunkContext,
  ContextOverflowConfig,
  DeliverNoticeOptions,
  ExtensionConfig,
  MessageMetadataCallback,
  OnStartDegradation,
  PrepareStepContext,
  RunTurnOptions,
  RunTurnStream,
  RunTurnSubmit,
  RunTurnWait,
  StepConfig,
  StepContext,
  StreamCallback,
  StreamableResult,
  ThinkModel,
  ThinkWorkflowPromptContext,
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  TurnConfig,
  TurnContext,
  TurnInput,
  TurnInputMessages,
  TurnResult,
  TurnTrigger
} from "./turn-types";

/**
 * A single approval awaiting a human decision, unified across pause backends so
 * dashboards/voice/messenger can list and reconcile everything pending with one
 * call. `source: "action"` is a parked `kind: "durable-pause"` action;
 * `source: "codemode"` is a paused `execute`-tool execution. Both resolve via
 * {@link Think.approveExecution} / {@link Think.rejectExecution}.
 */
export interface PendingApproval {
  executionId: string;
  source: "action" | "codemode";
  descriptor: ActionApprovalDescriptor;
}

export interface RejectExecutionOptions {
  /**
   * Whether Think starts a model continuation after recording the rejection.
   * Defaults to `true`. Set this to `false` when the caller wants the
   * conversation to remain paused until a later user turn.
   */
  autoContinue?: boolean;
}

type TurnAdmission = "queue" | "submit" | "execute-submission";

type AdmittedQueueResult<T> =
  | { status: "completed"; value: T }
  | { status: "stale" };

type QueueTurnSpec<T> = {
  admission: "queue";
  trigger: TurnTrigger;
  requestId: string;
  generation?: number;
  continuation?: boolean;
  allowNested?: boolean;
  channel?: string;
  /**
   * Ignore `channel` and extend the previous turn's channel, resolved when the
   * turn starts rather than when it is admitted, so it sees turns queued
   * ahead of it.
   */
  inheritChannel?: boolean;
  onQueued?: () => void;
  getStatus?: () => string | undefined;
  execute: () => Promise<T>;
};

type NonQueueTurnSpec<T> = {
  admission: Exclude<TurnAdmission, "queue">;
  trigger: TurnTrigger;
  channel?: string;
  execute: () => Promise<T>;
};

type TurnSpec<T> = QueueTurnSpec<T> | NonQueueTurnSpec<T>;

/** What an RPC `chat()` caller is told when the chat is cleared under it. */
const CHAT_CLEARED_ERROR = "The chat was cleared before the turn finished.";

const admittedTurnContext = new AsyncLocalStorage<{
  agent: unknown;
  requestId: string;
  trigger: TurnTrigger;
  admission: "queue";
  channel?: string | undefined;
  continuation?: boolean | undefined;
  generation?: number | undefined;
}>();

// A messenger turn waits in the turn queue before it runs, and a concurrent
// messenger turn can be admitted meanwhile, so the context has to travel with
// the call chain rather than sit on the instance.
const messengerTurnContext = new AsyncLocalStorage<{
  agent: unknown;
  context: MessengerContext;
  ended: boolean;
}>();

// Recovery acceptance belongs to the successor's async call chain, including
// pre-admission awaits and time spent in the turn queue. Concurrent turns on
// the same agent must not claim its handoff to a durable root chat Task.
const recoveredTurnAcceptanceContext = new AsyncLocalStorage<{
  agent: unknown;
  onAccepted: (successorRequestId: string) => void;
  workflowPrompt?: ThinkWorkflowPromptContext;
}>();

// A `runTurn` continuation dispatched through an overridden `continueLastTurn`:
// the base method, when the override delegates to it, records the full result
// (with structured output) for that `runTurn` call alone.
const continuationOutputContext = new AsyncLocalStorage<{
  agent: unknown;
  taken: boolean;
  result?: ProgrammaticMessagesResult;
}>();

// A `runTurn({ mode: "wait" })` call records the assistant message each turn
// persists, keyed by that turn's request ID. The context travels through the
// turn queue and inherited async work, so keying (not a single slot) keeps a
// later turn in the same context — e.g. an overridden `continueLastTurn` that
// runs another `saveMessages` — from replacing this turn's answer.
const waitTurnResultContext = new AsyncLocalStorage<{
  agent: unknown;
  messageIds: Map<string, string>;
}>();

// Marks code running inside `onSubmissionStatus`. The emit holds a terminal
// submission's waiters until the hook returns, and runs inside the turn that
// finalized it, so a wait from the hook can never settle.
const submissionStatusHookContext = new AsyncLocalStorage<{
  agent: unknown;
  ended: boolean;
}>();

type ActionLedgerRetentionConfig = {
  settledMs: number | false;
  pendingMs: number | false;
  maxSweepRows: number;
};

type ActionLedgerEvent =
  | {
      type: "action:ledger:replayed";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:pending";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:conflict";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:serialize_failed";
      payload: { action: string; key: string };
    }
  | {
      type: "action:ledger:settled";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:reclaimed";
      payload: {
        action: string;
        key: string;
        inputHash: string;
        ageMs: number;
      };
    }
  | {
      type: "action:ledger:swept";
      payload: { settled: number; pending: number };
    };

/**
 * A durably-parked `kind: "durable-pause"` action awaiting human approval. The
 * row is the compaction-safe record of everything needed to run `execute` on
 * approve (the transcript part can be summarized away before approval), so it
 * carries the action name, the model's input, and the approval descriptor.
 */
type ActionPendingRow = {
  execution_id: string;
  action_name: string;
  tool_call_id: string;
  request_id: string | null;
  input_json: string;
  descriptor_json: string | null;
  created_at: number;
};

type ActionPauseEvent =
  | {
      type: "action:pause:created";
      payload: { action: string; executionId: string; toolCallId: string };
    }
  | {
      type: "action:pause:approved";
      payload: { action: string; executionId: string };
    }
  | {
      type: "action:pause:rejected";
      payload: { action: string; executionId: string };
    }
  | {
      type: "action:pause:swept";
      payload: { swept: number };
    };

type ActionReplyEvent = {
  type: "action:reply-attached";
  payload: { action?: string; attachmentType: string };
};

export type ThinkSubmissionStatus =
  | "pending"
  | "running"
  | "completed"
  | "aborted"
  | "skipped"
  | "error";

export type SubmitMessagesOptions = {
  submissionId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  /** Channel id this submission belongs to. See the `channel` option of {@link RunTurnOptions}. */
  channel?: string;
};

const THINK_WORKFLOW_PROMPT_METADATA_KEY = "__thinkWorkflowPrompt";
/** Queue callback that delivers one terminal-submission workflow event. */
const WORKFLOW_NOTIFICATION_CALLBACK = "_cfDeliverWorkflowNotification";
/**
 * A workflow notification never retries in-process: a failed delivery
 * schedules its own retry with backoff (see `_cfDeliverWorkflowNotification`)
 * so the alarm loop is not held while a workflow is unreachable.
 */
const WORKFLOW_NOTIFICATION_RETRY: RetryOptions = { maxAttempts: 1 };
/** Longest wait between two delivery attempts of one workflow notification. */
const WORKFLOW_NOTIFICATION_MAX_BACKOFF_SECONDS = 10 * 60;
/**
 * How long delivery of one workflow notification keeps being retried after
 * its first failure. Long enough to ride out an outage of the workflow
 * binding; a target still failing after this is treated as permanently
 * unreachable rather than waking the object every ten minutes forever.
 */
const WORKFLOW_NOTIFICATION_GIVE_UP_MS = 12 * 60 * 60 * 1000;
/** Queue callback that runs one connection-less continuation turn. */
const CONNECTIONLESS_CONTINUATION_CALLBACK = "_cfRunConnectionlessContinuation";
const CONNECTIONLESS_CONTINUATION_QUEUE_ID = "connectionless-continuation";
/** The payload of the connection-less continuation's queue item. */
type ConnectionlessContinuation = {
  /** The messages the approvals' outcomes are stored in. */
  targetMessageIds: string[];
  /**
   * The number of stops of every chat when the item was pushed
   * (`connectionlessStops` in `think_config`, durable). An item pushed
   * before a later stop does not run.
   */
  stops?: number;
};
/** `think_config` key of the count of stops of every chat. */
const CONNECTIONLESS_STOPS_KEY = "connectionlessStops";
/** Queue callback that runs one media-eviction pass. */
/** Queue callback that runs one pending submission. */
const SUBMISSION_RUN_CALLBACK = "_cfRunSubmission";

function workflowNotificationItemId(
  submissionId: string,
  eventType: string
): string {
  return `workflow-notification:${submissionId}:${eventType}`;
}

function submissionRunItemId(submissionId: string): string {
  return `submission:${submissionId}`;
}

/**
 * `parts` without the text and reasoning that follow the part for
 * `toolCallId`, up to the end of the step that read its output: the rest of
 * the tool call's own step and the next one. Later steps answer other tool
 * results and are kept. Returns `parts` itself when nothing is dropped.
 */
function dropGenerationAfterToolCall(
  parts: UIMessage["parts"],
  toolCallId: string
): UIMessage["parts"] {
  const index = parts.findIndex(
    (part) => "toolCallId" in part && part.toolCallId === toolCallId
  );
  if (index === -1) return parts;
  let end = parts.length;
  let stepStarts = 0;
  for (let i = index + 1; i < parts.length; i++) {
    if (parts[i].type === "step-start" && ++stepStarts === 2) {
      end = i;
      break;
    }
  }
  const kept = parts.filter(
    (part, i) =>
      i <= index ||
      i >= end ||
      (part.type !== "text" && part.type !== "reasoning")
  );
  return kept.length === parts.length ? parts : kept;
}

export type ThinkSubmissionInspection = {
  submissionId: string;
  idempotencyKey?: string;
  requestId?: string;
  status: ThinkSubmissionStatus;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Id of the assistant message this submission's turn persisted. */
  messageId?: string;
};

export type SubmitMessagesResult = ThinkSubmissionInspection & {
  accepted: boolean;
};

export type WaitForSubmissionOptions = {
  /**
   * Stop waiting after this many milliseconds and return the submission as it
   * is then, still `pending` or `running`, or `null` if it was deleted.
   */
  timeoutMs?: number;
};

/** What {@link Think.cancelSubmission} did. */
export type CancelSubmissionResult =
  | {
      /** No submission has this id. */
      outcome: "not_found";
      submissionId: string;
    }
  | {
      /** The submission had already finished; nothing changed. */
      outcome: "already_terminal";
      submissionId: string;
      submission: ThinkSubmissionInspection;
    }
  | {
      /** The submission is now `aborted`. */
      outcome: "cancelled";
      submissionId: string;
      /**
       * `"pending"`: removed before its turn started. `"running"`: its turn
       * had been claimed and was signalled to abort; side effects already
       * under way may still finish.
       */
      previousStatus: "pending" | "running";
      /**
       * Whether any of the submission's messages were written to the
       * conversation when it was cancelled. A claimed submission can still be
       * `false` when it is cancelled before its turn applies them.
       */
      messagesApplied: boolean;
      submission: ThinkSubmissionInspection;
    };

export type ListSubmissionsOptions = {
  status?: ThinkSubmissionStatus | ThinkSubmissionStatus[];
  limit?: number;
};

export type DeleteSubmissionsOptions = {
  status?: ThinkSubmissionStatus | ThinkSubmissionStatus[];
  completedBefore?: Date;
  limit?: number;
};

/** A turn's durable cutover fact, not the stream transport's lifecycle. */
type SubmissionTurnResult =
  | { status: "completed"; output?: unknown }
  | { status: "aborted" | "retry" | "error" };

type ThinkSubmissionRow = {
  submission_id: string;
  idempotency_key: string | null;
  request_id: string | null;
  stream_id: string | null;
  status: ThinkSubmissionStatus;
  messages_json: string;
  metadata_json: string | null;
  error_message: string | null;
  created_at: number;
  messages_applied_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  result_status: SubmissionTurnResult["status"] | null;
  output_json: string | null;
  message_id: string | null;
};

/** Payload of one queued workflow notification. */
type WorkflowNotificationPayload = {
  workflowName: string;
  workflowId: string;
  event: { type: string; payload: unknown };
  /** Failed deliveries so far; drives the retry backoff. */
  attempts?: number;
  /** Epoch ms of the first failed delivery; bounds the retry window. */
  firstFailedAt?: number;
};

// Lifecycle / result types are shared with `@cloudflare/ai-chat` via
// `agents/chat`. Re-exported from Think so subclasses can import them
// from `@cloudflare/think` directly.
export type {
  ChatResponseResult,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryProgressContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  ResolvedChatRecoveryConfig,
  SaveMessagesOptions,
  SaveMessagesResult,
  SkippedTurnReason
} from "agents/chat";
import type {
  ChatResponseResult,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  ResolvedChatRecoveryConfig,
  SaveMessagesOptions,
  SaveMessagesResult
} from "agents/chat";

const { snapshot: snapshotDeclaredMembers, isOverridden: isMethodOverridden } =
  declaredOverrides(() => Think.prototype);

/**
 * What `Think` stores with a client request's admission record, to run it
 * again after an isolate reset. See `ChatTurns.resumeAdmissions`.
 */
type StoredThinkClientRequest = {
  trigger: "submit-message" | "regenerate-message";
  clientTools: ClientToolSchema[] | undefined;
  body: Record<string, unknown>;
  originMessageIds: string[] | undefined;
  /** A regenerate: the message whose reply it replaces. */
  branchParentId: string | undefined;
};

export class Think<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends object = object
> extends Agent<Env, State, Props> {
  // Root requestId of the in-flight recovery chain, threaded into each
  // continuation's snapshot so chained continuations keep owning the original
  // submission. This is a single instance field, NOT per-incident: it is only
  // safe because turns (and recovery fibers) are serialized by the turn queue,
  // so at most one recovery chain is active at a time. The `try/finally`
  // restore in `_chatRecoveryRetry` / `_chatRecoveryContinue` returns it to the
  // prior value once a continuation settles. If turns ever run concurrently,
  // this must move to per-incident storage.
  /** The engine keeps the root request id of the recovery work now running. */
  private get _activeChatRecoveryRootRequestId(): string | undefined {
    return this._chatRecoveryEngine().activeRootRequestId;
  }
  /**
   * The originating user message ids of the active recovery chain (#2280),
   * carried in the recovery payload because the successor turn runs under a
   * fresh request id. Scoped to the recovery callback's async context, so a
   * concurrent client request never inherits them.
   */
  private _chatRecoveryOriginIdsScope = new AsyncLocalStorage<
    string[] | undefined
  >();

  private get _activeChatRecoveryOriginIds(): string[] | undefined {
    return this._chatRecoveryOriginIdsScope.getStore();
  }

  /**
   * Whether Think automatically converts connected MCP tools to AI SDK tools
   * and merges them into each model turn.
   *
   * Set this to `false` when MCP tools are exposed through Code Mode or another
   * mechanism outside Think's automatic tool set. Connections, discovery,
   * `waitForMcpConnections`, raw tool listing and calls, and explicit
   * `this.mcp.getAITools()` calls are unaffected.
   *
   * @default true
   */
  includeMcpTools = true;

  /**
   * Wait for MCP server connections to be ready before the inference loop.
   * When {@link includeMcpTools} is enabled, their tools are then auto-merged
   * into the tool set.
   *
   * Set to `true` for a default 10s timeout, or `{ timeout: ms }`
   * for a custom timeout. Defaults to `false` (no waiting).
   */
  waitForMcpConnections: boolean | { timeout: number } = false;

  /** Store model input/output on `chat` spans. */
  storeMessages = false;

  /** Store tool input/output on `execute_tool` spans. */
  storeTools = false;

  /** Skills loaded from `getSkills()`. */
  readonly #skills = new ThinkSkills();
  private _loggedProtocolWarnings = new Set<string>();

  /**
   * Controls how overlapping user submit requests behave while another
   * chat turn is already active or queued.
   *
   * @default "queue"
   */
  messageConcurrency: MessageConcurrency = "queue";

  /**
   * How the Chat SDK handles messages that arrive in a messenger thread while
   * the agent is still answering, or before it starts. Accepts any Chat SDK
   * `concurrency` value: `"queue"`, `"debounce"`, `"burst"`, `"concurrent"`,
   * `"drop"`, or a `ConcurrencyConfig`. One setting covers every messenger on
   * the agent. Set it as a class field: it is read before `onStart` runs.
   *
   * @default { strategy: "burst", debounceMs: 600 }
   */
  messengerConcurrency: MessengerConcurrency = DEFAULT_MESSENGER_CONCURRENCY;

  /**
   * Byte budget for hydrating the persisted transcript into the in-memory
   * message cache (`this.messages`).
   *
   * Hydration runs on every wake (and at safe boundaries during a session).
   * Without a budget it materializes the ENTIRE stored conversation — for
   * long-lived, media-heavy sessions that footprint approaches the isolate's
   * 128MB memory budget and the next SQLite allocation fails with
   * `SQLITE_NOMEM`, permanently bricking the DO (#1710).
   *
   * When the stored path exceeds the budget, only the most recent messages
   * that fit are hydrated — never fewer than the recent window the model
   * sees at full fidelity (the `truncateOlderMessages` default of 4), even
   * when those messages alone exceed the budget — a
   * `chat:hydration:windowed` observability event is emitted, and
   * `this.messages` exposes the bounded window. Durable storage is never
   * truncated by this — `session.getHistory()` still reads the full path.
   * The model-facing context is unaffected: older content is already
   * truncated at read time before each turn, and the hydration floor
   * guarantees the full-fidelity span is always present.
   *
   * The budget counts what hydration actually costs: a row's stored bytes
   * plus the attachment bytes its pointers inflate back when reconstructed
   * inline. A pointer row is therefore charged its payload, not its ~100
   * stored bytes, so the ceiling bounds isolate memory rather than the
   * on-disk footprint. Set to `Number.POSITIVE_INFINITY` (or any
   * non-positive value) to disable windowing and always hydrate the full
   * transcript.
   *
   * Once the transcript exceeds the budget, the hydrated window's start
   * slides forward as messages are added, which rewrites the start of the
   * prompt and defeats provider prompt caching (and the step alignment of
   * `truncationStep`) until the transcript fits again.
   *
   * @default 32 * 1024 * 1024
   */
  hydrationByteBudget: number = 32 * 1024 * 1024;

  /**
   * Aged-media eviction — a CONTEXT-WINDOW technique, not a storage setting.
   *
   * Once media has aged past `keepRecentMessages` on the active path, Think
   * removes it from the conversation so the model stops re-reading a large
   * image on every turn, and leaves a marker naming a Workspace file under
   * `/attachments/evicted/`. The bytes are written raw with their real mime
   * type, so the agent can read the picture back with the workspace `read`
   * tool when it deliberately needs it again. Visible to the model and lossy
   * on purpose.
   *
   * This is separate from Sessions attachment storage, which is invisible
   * and lossless: a large payload may be held as an `attachment:sha256:`
   * pointer whether eviction is on or off.
   *
   * `false` keeps aged media in the conversation, so the model keeps seeing
   * it. It does NOT change where Sessions keeps the bytes.
   *
   * Eviction only rewrites messages below the stepped read-time truncation
   * cutoff (see `truncationStep`), moved back whole steps until at least
   * `keepRecentMessages` messages stay above it. It therefore never rewrites
   * a message the model still replays at full fidelity, and it changes the
   * cached prompt prefix at most once per truncation step rather than every
   * turn. The media of up to `keepRecentMessages + truncationStep - 1`
   * recent messages can stay in context.
   *
   * @default true
   */
  mediaEviction: MediaEvictionConfig | boolean = true;

  /**
   * Durable chat recovery configuration. Every chat turn runs in `runFiber`,
   * enabling `onChatRecovery` and `this.stash()` during streaming. Assign an
   * object to tune recovery budgets and terminal behavior.
   *
   * Assign this as a class field or in the constructor — NOT in `onStart()`.
   * On every wake the SDK evaluates recovery budgets (and may seal an
   * interrupted turn, firing `onExhausted`) before `onStart()` runs, so a config
   * set in `onStart()` is applied too late and the built-in defaults are used
   * for the recovery that matters. See {@link ChatRecoveryConfig}.
   */
  chatRecovery: ChatRecoveryConfig = true;

  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";

  /** Durable conversation history installed on this Agent's Lifecycle. */
  readonly sessions = new Sessions({
    reservedMetadataKeys: RESERVED_MESSAGE_METADATA_KEYS
  });

  /**
   * The default conversation handle configured by `configureSession()`.
   * Storage lives on the `agents/sessions` handle it wraps; the context
   * methods it still carries forward to {@link Think.context}.
   */
  session!: ThinkSession;

  /** Prompt context blocks for this agent, built from `configureContext()`. */
  #contextBlocks: ContextBlocks | undefined;

  /**
   * The agent's context blocks. Available once the Lifecycle has started.
   */
  protected get context(): ContextBlocks {
    if (!this.#contextBlocks) {
      throw new Error(
        "Context is not initialized yet; it is available after onStart()."
      );
    }
    return this.#contextBlocks;
  }

  /** Durable SQLite storage for one context block of this agent. */
  #contextProvider(label: string): WritableContextProvider {
    const sessionId = this.session?.sessionId ?? "";
    return new AgentContextProvider(
      this,
      sessionId ? `${label}_${sessionId}` : label
    );
  }

  /** Cached messages, kept in sync with session storage. */
  private readonly _cfTranscript = new ThinkTranscriptCache({
    budget: () => this.hydrationByteBudget,
    readAll: () => this._readMessagesFromStorage(),
    readRecent: async (budget) => {
      const recent = await this.session.getRecentHistory(budget);
      return { ...recent, messages: recent.messages as UIMessage[] };
    },
    emitWindowed: (payload) => this._emit("chat:hydration:windowed", payload),
    refreshed: () => this._cfMediaEviction.request()
  });

  private get _cachedMessages(): UIMessage[] {
    return this._cfTranscript.messages;
  }

  private set _cachedMessages(messages: UIMessage[]) {
    this._cfTranscript.messages = messages;
  }
  private _unsubscribeSessionChanges: (() => void) | undefined;

  /**
   * Internal onStart steps that failed on this wake and were skipped so the
   * agent could still come up.
   *
   * onStart failures are terminal: partyserver resets its init state and
   * rethrows, so every subsequent wake — including platform alarm retries —
   * re-runs the failing onStart. A data-driven failure (e.g. SQLITE_NOMEM
   * hydrating an oversized transcript) would otherwise permanently brick the
   * DO and drive an unbounded alarm-retry loop (#1710).
   */
  protected _onStartDegradations: OnStartDegradation[] = [];

  /**
   * Internal onStart steps that failed on this wake and were skipped so the
   * agent could still come up (see {@link OnStartDegradation}). Empty when
   * boot was clean. Lets hosts and operators surface degraded boots —
   * e.g. via a health RPC — without subclassing.
   */
  getOnStartDegradations(): ReadonlyArray<OnStartDegradation> {
    return [...this._onStartDegradations];
  }

  /**
   * Turn-scoped channel context (superset of `_activeMessengerContext`). Set on
   * both the queue and submit admission paths via `_withChannelContext`, read by
   * `deliverNotice` and per-channel policy. Save/restore keeps nested turns safe.
   */
  private _activeChannelContext?: ChannelContext;

  /**
   * Channel of the latest queue turn that ran inference, which a continuation
   * without an explicit channel extends. Cleared by `resetTurnState`. Differs from the latest user message's
   * channel when a WebSocket regeneration reuses a message another channel
   * stored, or a continuation ran on an explicit channel. In memory only:
   * after an eviction, continuations fall back to history.
   */
  private _lastTurnChannel?: { channel: string | undefined };

  /**
   * Live delivery surface for the active turn, bound by `deliverMessengerReply`
   * so `deliverNotice` can post to the originating channel mid-turn. Save/restore
   * keeps nested turns safe.
   */
  private _activeDeliverySurface?: MessengerDeliverySurface;

  private _messengerRuntime?: ThinkMessengerRuntime;

  /** Resolved channel registry (implicit web + configureChannels + messengers). */
  private _channels?: Map<string, NormalizedChannelDefinition>;

  /**
   * WorkerLoader binding for sandboxed extensions.
   * Set this to enable `getExtensions()` and dynamic extension loading.
   */
  extensionLoader?: WorkerLoader;

  /**
   * Extension manager — created automatically when `extensionLoader` is set.
   * Use for dynamic `load()` / `unload()` at runtime.
   */
  extensionManager?: import("./extensions/manager").ExtensionManager;

  /**
   * The agent's Workspace, available in `getTools()` and lifecycle hooks.
   * Defaults to a `Workspace` from `@cloudflare/computer` on this Durable
   * Object's storage, with no execution backends.
   *
   * Override it as a class field to add backends, mounts, or git, or to
   * work in a Workspace another Durable Object owns:
   *
   * ```typescript
   * import { Workspace, type WorkspaceStub } from "@cloudflare/computer";
import { createAITools } from "@cloudflare/computer/tools/ai-sdk";
   *
   * override workspace = new Workspace({
   *   storage: this.ctx.storage,
   *   backends: [...]
   * });
   *
   * // A Workspace owned by a parent Durable Object.
   * override workspace = await getWorkspace(parentStub);
   * ```
   */
  workspace!: ThinkWorkspace;

  /**
   * The codemode runtime behind the execute tool, when one has been created
   * via `createExecuteRuntime(this)` / `createExecuteTool(this)` (from
   * `@cloudflare/think/tools/execute`). Gives callables and lifecycle hooks
   * access to approvals (`approve`/`reject`/`pending`), the audit trail
   * (`executions`), `expirePaused`, and snippets.
   */
  codemode?: import("@cloudflare/codemode").CodemodeRuntimeHandle;

  /**
   * Opt-in HTTP fetch tools. Disabled by default — set to a config object to
   * register a generic `fetch_url` tool (when `allowlist` is provided) and one
   * `fetch_<name>` tool per `bindings` target. Read-only (GET), allowlisted,
   * and bounded; see {@link createFetchTools}.
   *
   * The workspace and an observability hook are injected automatically, so omit
   * `workspace`/`onEvent` here. This property is evaluated at construction, so
   * use it for static config — for per-tenant/dynamic allowlists call
   * `createFetchTools()` inside `getTools()` instead (it runs every turn).
   *
   * ```ts
   * fetchTools = { allowlist: ["https://developers.cloudflare.com/**"] };
   * ```
   */
  fetchTools: false | Omit<CreateFetchToolsOptions, "workspace" | "onEvent"> =
    false;

  constructor(ctx: DurableObjectState, env: Env) {
    snapshotDeclaredMembers(new.target.prototype);
    super(ctx, env);

    this.lifecycle.use(this.sessions);
    this.lifecycle.use(this._cfConfig);
    this.lifecycle.use(this._cfMediaEviction);
    this.lifecycle.use(this.streams);
    this.lifecycle.use(this._approvals);
    this._registerChatTurnTaskDefinition();
    this._registerChatRecoveryTaskDefinition();
    this.#messengerReplies = new MessengerReplies(
      this.tasks,
      () => this._messengerRuntime
    );
    this.lifecycle.use(this.#messengerReplies);

    const _onStart = this.onStart.bind(this);
    const startThink = async (
      props: Props | undefined,
      update: (
        attributes: Record<string, string | number | boolean | undefined>
      ) => void
    ) => {
      await this._withAgentSpan(
        "initialize_think_session",
        "startup",
        { "cloudflare.agents.component": "think" },
        async () => {
          // 1. Workspace initialization
          if (!this.workspace) {
            this.workspace = new Workspace({ storage: this.ctx.storage });
          }

          // 2. Session configuration (builder phase: compaction, and the
          //    pre-Sessions `withContext()` chain, folded into the blocks
          //    `configureContext()` declares).
          this.session = await this.configureSession(
            new ThinkSession(this.sessions.session(), () => this.context)
          );
          this.#contextBlocks = new ContextBlocks(
            [
              ...(await this.configureContext()),
              ...this.session.internal_takePendingContext()
            ],
            this.session.internal_promptStore() ??
              this.#contextProvider("_system_prompt"),
            (label) => this.#contextProvider(label)
          );
          // Load blocks now rather than on the first turn, as Think always
          // has: the synchronous accessors (`this.context.getBlock()` and the
          // pre-Sessions `session.getContextBlock()`) are expected to answer
          // as soon as the object has started.
          await this.#contextBlocks.load();
          this._unsubscribeSessionChanges?.();
          this._unsubscribeSessionChanges = this.sessions
            .session(this.session.sessionId)
            .mirror<UIMessage>({
              get: () => this._cfTranscript.messages,
              set: (messages) => {
                this._cfTranscript.replace(messages);
              },
              transform: (message) => message as UIMessage,
              intercept: async (event) => {
                switch (event.type) {
                  case "append":
                    // A branch append moves the path itself, which no
                    // in-place patch expresses.
                    if (event.inserted && event.parentId === undefined) {
                      return false;
                    }
                    await this._cfTranscript.sync();
                    return true;
                  case "import":
                    // A row the cache never saw. Re-derive at the next safe
                    // boundary instead of mirroring a migration row by row.
                    this._cfTranscript.coversActivePath = false;
                    return true;
                  case "clear":
                    this._cfTranscript.replace([]);
                    this._cfTranscript.coversActivePath = true;
                    return true;
                  case "compaction":
                  case "delete":
                    await this._cfTranscript.sync();
                    return true;
                  case "compact":
                    await this._cfTranscript.sync();
                    await this.#contextBlocks?.refreshSystemPrompt();
                    return true;
                  default:
                    return false;
                }
              },
              onApplied: (event, message, previous) => {
                if (event.type === "update") {
                  if (previous) this._noteCachedReplacement(previous, message);
                  return;
                }
                // A linear append is what ages older messages, so this is
                // where an eviction pass becomes worth scheduling; the gate
                // decides from memory. It also grows the cache past what the
                // last refresh measured.
                this._cfTranscript.noteGrowth(cachedMessageBytes(message));
                this._cfMediaEviction.noteAppend();
              }
            });

          await this.#skills.initialize(() => this.getSkills(), this.context);
        }
      );

      //
      // Hydration is bounded by `hydrationByteBudget` (a byte-budgeted
      // recent window on oversized transcripts), but even the budgeted read
      // can fail — and that failure must not escape onStart, or the DO is
      // bricked (#1710). Degrade to an empty in-memory view; persisted
      // history is untouched and the next safe-boundary `_cfTranscript.sync()`
      // retries.
      this._onStartDegradations = [];
      await this._withAgentSpan(
        "hydrate_think_session",
        "startup",
        { "cloudflare.agents.component": "think" },
        async () => {
          const hydrated = await this._runBestEffortOnStartStep(
            "transcript-hydration",
            () => this._cfTranscript.sync(),
            "The agent is starting with an empty in-memory message view; " +
              "persisted history is untouched. If the error is SQLITE_NOMEM, " +
              "the stored transcript is too large to hydrate (often inline " +
              "base64 media in tool results) — compact or clear the session " +
              "to recover."
          );
          if (!hydrated) {
            this._cfTranscript.replace([]);
          }
        }
      );

      // 3-6. Extension initialization (if extensionLoader is set)
      if (this.extensionLoader) {
        await this._withAgentSpan(
          "initialize_think_extensions",
          "startup",
          { "cloudflare.agents.component": "think" },
          () => this._initializeExtensions()
        );
      }

      // 7. Protocol handlers
      await this._withAgentSpan(
        "initialize_think_chat",
        "startup",
        { "cloudflare.agents.component": "think" },
        async () => {
          this._resumableStream = new ResumableStream(
            this.streams,
            this.sql.bind(this),
            {
              // Rollback insurance: a build still on the KV counter reads a
              // marker no lower than one recorded under the derived marker.
              // One put per stream retired, none per chunk.
              onProgress: (durable) => {
                void this.ctx.storage
                  .put(CHAT_RECOVERY_PROGRESS_KEY, durable)
                  .catch(() => {});
              }
            }
          );
          this._requestContext.restore();
          this._setupProtocolHandlers();
          await this._initializeChannels();
        }
      );

      // 8. User's onStart
      await _onStart(props);

      // 9. Declarative scheduled tasks are code-defined and should reconcile
      // before draining any recovered programmatic work they may enqueue.
      // Best-effort: reconcile runs after the agent is otherwise functional,
      // and a failure (user getScheduledTasks() throwing, storage pressure)
      // must not brick the DO (#1710).
      await this._withAgentSpan(
        "reconcile_think_schedules",
        "startup",
        { "cloudflare.agents.component": "think" },
        () =>
          this._runBestEffortOnStartStep(
            "scheduled-task-reconcile",
            () => this.internal_reconcileScheduledTasks(),
            "Declared scheduled tasks were not reconciled on this wake; the " +
              "next successful wake will reconcile them."
          )
      );

      // 10. Durable submissions may run user-defined model/hooks, so start them
      // after subclass initialization has completed. Best-effort for the same
      // reason as step 9.
      await this._withAgentSpan(
        "recover_think_durable_work",
        "startup",
        { "cloudflare.agents.component": "think" },
        () =>
          this._runBestEffortOnStartStep(
            "durable-work-recovery",
            async () => {
              // The app's onStart is done: replays may run from here on,
              // also when a step below fails.
              this._appStartedForAdmissions = true;
              await this._migrateLegacyActionLedger();
              await this._sweepApprovals();
              await this._sweepActionPendingApprovals();
              await this._migrateLegacyWorkflowNotifications();
              await this._replayPendingResponseHooks();
              await this._replayMessengerRecoveryDeliveries();
              await this._recoverSubmissionsOnStart();
              // Requests an earlier isolate accepted and never started run
              // again, once no interrupted turn waits for recovery.
              this._resumeAdmissions();
            },
            "Pending submissions / workflow notifications were not recovered on " +
              "this wake; the next successful wake will recover them."
          )
      );

      update({
        "cloudflare.agents.hydration.messages":
          this._lastHydration?.hydratedMessages,
        "cloudflare.agents.hydration.content_bytes":
          this._lastHydration?.totalContentBytes,
        "cloudflare.agents.hydration.truncated": this._lastHydration?.truncated,
        "cloudflare.agents.start.degradations": this._onStartDegradations.length
      });
    };
    this.onStart = (props?: Props) =>
      this._withAgentSpan(
        "think_start",
        "startup",
        { "cloudflare.agents.component": "think" },
        (update) => startThink(props, update)
      );
  }

  /**
   * Conversation history as Think's live in-memory view.
   *
   * Storage remains the durable source of truth, but runtime logic should read
   * through this cache so in-flight turns, tool updates, and recovery state all
   * observe the same message list. Use `_cfTranscript.sync()` only at safe
   * boundaries where a full storage reread cannot drop in-flight state.
   *
   * When the stored transcript exceeds `hydrationByteBudget`, this view is a
   * bounded window of the most recent messages (see `_lastHydration`); the
   * full history remains readable via `session.getHistory()`.
   */
  get messages(): UIMessage[] {
    return this._cfTranscript.messages;
  }

  /**
   * Read the durable message path from session storage.
   *
   * Intentionally UNBUDGETED — unlike the cache refresh in `_cfTranscript.sync()`,
   * which routes through `session.getRecentHistory(hydrationByteBudget)`, this
   * returns the full active path. Its caller, message reconciliation, must see
   * every message: it diffs incoming client messages against the complete
   * server transcript, so a windowed read would drop rows and corrupt the
   * result. It is reached only when the live cache does not already cover the
   * path (`_serverTranscriptForReconcile`); tool-update application resolves
   * its one target row without it (`_resolveToolCallOwner`).
   *
   * These full reads are not the unbounded boot-time hydration that bricked the
   * DO in #1710: they run during a live turn (never in `onStart`), so an
   * `SQLITE_NOMEM` here surfaces as a recoverable turn-level error rather than a
   * partyserver init-reset/alarm-retry loop. They also inherit step 1's
   * mitigation — `session.getHistory()` now fetches content in bounded chunks
   * (`messagesByPathIds`) instead of carrying blobs through the recursive CTE
   * and its `ORDER BY` sorter — and background media eviction shrinks the stored
   * footprint over time, so the steady-state read size converges down.
   */
  private async _readMessagesFromStorage(): Promise<UIMessage[]> {
    return (await this.session.getHistory()) as UIMessage[];
  }

  /**
   * Repair a single interrupted tool call — a tool part with no settled result,
   * left behind when a stream was cut off mid-flight. Returns the replacement
   * part that takes its place in the transcript. `input` has already been
   * normalized to a valid object.
   *
   * The default flips it to an errored tool result so the record survives (no
   * "disappearing" tool call) and `convertToModelMessages` still gets a
   * tool-result for it (avoiding `AI_MissingToolResultsError`).
   *
   * Override to customize the repaired shape for client-resolved tools — e.g.
   * convert an interrupted `ask_user` (a question with no server `execute`,
   * normally answered by the user's next message) into a plain text part
   * carrying the question prose, so the model sees it as ordinary conversation
   * rather than a tool error and compaction keeps the question verbatim. This
   * runs DURING transcript repair — before the repaired transcript is persisted
   * and sent to the model — so the conversion shapes the current turn, not just
   * the next one. A returned tool part MUST carry a settled result
   * (`output-available` / `output-error` / `output-denied` or an
   * `output`/`result` field); returning a non-tool part (e.g. text) is fine.
   *
   * It also receives an approved call that never ran (state still
   * `approval-responded`) once a later turn moves past it without a
   * continuation executing it.
   */
  protected repairInterruptedToolPart(
    part: UIMessage["parts"][number]
  ): UIMessage["parts"][number] {
    return interruptedToolPartAsError(part, {
      clientToolNames: this._requestContext.clientToolNames()
    });
  }

  /**
   * Whether the turn running now continues the last message. The before-turn
   * repair reads it. Set when the turn's inference is prepared and reset when
   * the turn ends, so nothing outside a turn sees a stale `true`. Turns run
   * one at a time on the turn queue, so there is one value at a time.
   */
  private _turnIsContinuation = false;

  /**
   * How a repaired transcript is stored and reported: update each changed
   * message in the Session, patch the cached copy by id (the repaired list
   * can be a cut or off-cache path), broadcast, then the
   * `chat:transcript:repaired` event. A reply the repair left empty is
   * removed.
   */
  private _repairedTranscriptSink(): RepairedTranscriptSink {
    return {
      persist: async (changed) => {
        // The copy the Session stored goes into the cache, and its growth
        // is charged to the hydration budget. A message off the cached
        // path (a cut history) is left out of the cache.
        for (const message of changed) {
          this._patchCachedMessage(await this._updateMessageInHistory(message));
        }
        this._broadcastMessages();
      },
      // The Session splices a removed message's children onto its parent.
      // The broadcast carries the whole list, so every tab drops it.
      remove: async (ids) => {
        await this.session.deleteMessages(ids);
        await this._cfTranscript.sync();
        this._broadcastMessages();
      },
      emitRepaired: (event) => this._emit("chat:transcript:repaired", event)
    };
  }

  private _repairAndPersistTranscript(
    messages: UIMessage[]
  ): Promise<BeforeTurnRepairResult> {
    return this._turns.settleBeforeTurn(
      messages,
      {
        continuation: this._turnIsContinuation,
        repairPart: (part) => this.repairInterruptedToolPart(part)
      },
      this._repairedTranscriptSink()
    );
  }

  /**
   * Run a best-effort internal onStart step, degrading on failure instead of
   * throwing.
   *
   * Throwing out of `onStart` is terminal: partyserver resets its init state
   * and rethrows, so every wake — including platform alarm retries — re-runs
   * the failing `onStart` and fails again. A data-driven failure (oversized
   * transcript, bad declared-task config) would permanently brick the DO and
   * drive an unbounded alarm-retry loop (#1710). Instead, record the
   * degradation, emit `chat:onstart:degraded`, and let the agent come up so
   * it stays reachable for remediation (compaction, clearing, redeploy).
   *
   * Returns `true` when the step succeeded.
   */
  private async _runBestEffortOnStartStep(
    step: OnStartDegradation["step"],
    fn: () => unknown | Promise<unknown>,
    hint: string
  ): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (error) {
      this._onStartDegradations.push({ step, error });
      console.error(
        `[Think] onStart step "${step}" failed; continuing with degraded state. ${hint}`,
        error
      );
      this._emit("chat:onstart:degraded", {
        step,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  /** Aged-media eviction passes (see `mediaEviction`). */
  private readonly _cfMediaEviction = new MediaEvictionPasses({
    config: () => resolveMediaEvictionConfig(this.mediaEviction),
    truncationStep: () => this.truncationStep,
    cachedMessages: () => this._cfTranscript.messages,
    agedRowsHiddenFromCache: () =>
      this._lastHydration?.truncated === true ||
      this._cfTranscript.messages.some((message) =>
        isCompactionMessage(message as SessionMessage)
      ),
    storedBytes: () => this._lastHydration?.totalContentBytes ?? null,
    rowStats: () => this.session.getHistoryRowStats(),
    readMessage: async (id) =>
      (await this.session.getMessage(id)) as UIMessage | null,
    openFiles: () => new WorkspaceFiles(this.workspace),
    updateMessage: (message) => this._updateMessageInHistory(message),
    emitEvicted: (totals) =>
      this._emit("chat:media:evicted", {
        ...totals,
        externalizedBytes: totals.bytes
      }),
    // Every facet shares the root's queue, so each names its pass by its
    // path (class and name at each level).
    queueRouted: () =>
      this.queue("_cfEvictAgedMedia", undefined, {
        id: `media-eviction:${JSON.stringify(this.selfPath)}`
      })
  });

  /**
   * Run one media-eviction pass queued on the Agent queue: by a sub-agent
   * facet, which has no alarm of its own, or by an older version.
   * @internal Queue callback.
   */
  async _cfEvictAgedMedia(): Promise<void> {
    await this._evictAgedMediaBestEffort();
  }

  /** Run one bounded eviction pass now. @internal Exposed for tests. */
  protected _evictAgedMediaBestEffort(): Promise<MediaEvictionPassResult | null> {
    return this._cfMediaEviction.run();
  }

  /**
   * Result of the most recent cache refresh when `hydrationByteBudget` is
   * active. `truncated` means `this.messages` is a bounded recent window of
   * a larger stored transcript.
   */
  protected get _lastHydration(): HydrationResult | null {
    return this._cfTranscript.lastHydration;
  }

  /** Whether `this.messages` holds every message on the active path. */
  private get _cacheCoversActivePath(): boolean {
    return this._cfTranscript.coversActivePath;
  }

  private set _cacheCoversActivePath(covers: boolean) {
    this._cfTranscript.coversActivePath = covers;
  }

  /** Patch a message that is already present in the live cache. */
  private _patchCachedMessage(message: UIMessage): void {
    const index = this._cfTranscript.messages.findIndex(
      (m) => m.id === message.id
    );
    if (index === -1) return;
    const previous = this._cfTranscript.messages[index];
    this._cfTranscript.messages[index] = message;
    this._noteCachedReplacement(previous, message);
  }

  /**
   * An update that enlarges a cached message (a tool result landing on it)
   * grows the cache exactly as an append does, so it is charged against the
   * hydration budget the same way; and it may have put an inline payload on
   * an aged row, so a fruitless eviction pass no longer stands.
   */
  private _noteCachedReplacement(previous: UIMessage, next: UIMessage): void {
    const grew = cachedMessageBytes(next) - cachedMessageBytes(previous);
    if (grew > 0) {
      this._cfTranscript.noteGrowth(grew);
      this._cfMediaEviction.invalidate();
    }
  }

  private async _appendMessageToHistory(
    message: UIMessage,
    parentId?: string | null
  ): Promise<UIMessage> {
    const result = await this.session.appendMessage(message, { parentId });
    return result.message as UIMessage;
  }

  private async _updateMessageInHistory(
    message: UIMessage
  ): Promise<UIMessage> {
    // `null` means the row is gone (a concurrent clear or delete). Keep the
    // caller's copy so the live cache stays coherent.
    return ((await this.session.updateMessage(message)) ??
      message) as UIMessage;
  }

  private async _upsertMessageInHistory(
    message: UIMessage,
    parentId?: string | null,
    source: "client" | "server" = "server"
  ): Promise<UIMessage> {
    const result = await this.session.upsertMessage(message, {
      parentId,
      source
    });
    return result.message as UIMessage;
  }

  /** Session-backed orphan persistence with Think's default branch. */
  protected _orphanStore(): OrphanPersistStore {
    return {
      getMessage: async (id) =>
        (await this.session.getMessage(id)) as UIMessage | null,
      appendMessage: async (message, parentId) => {
        await this.session.appendMessage(message, { parentId });
      },
      updateMessage: async (message) => {
        await this.session.updateMessage(message);
      }
    };
  }

  private async _clearHistory(): Promise<void> {
    await this.session.clearMessages();
    // The transcript carried the skill-load record, so a cleared session
    // starts with no skills loaded and a prompt rebuilt without them.
    await this.#contextBlocks?.refreshSystemPrompt();
    // Drop any pending terminal record (#1645) so a stale exhaustion can't
    // replay onto a freshly-cleared (empty) conversation on reconnect. Covers
    // both the WS `chat-clear` path and the programmatic `clearMessages()` API.
    await this._clearChatTerminal();
    clearRecentChatTerminals(this.ctx.storage.kv);
  }

  /** Append a message while keeping Think's live message cache coherent. */
  protected appendMessageToHistory(
    message: UIMessage,
    parentId?: string | null
  ): Promise<UIMessage> {
    return this._appendMessageToHistory(message, parentId);
  }

  /** Update a message while keeping Think's live message cache coherent. */
  protected updateMessageInHistory(message: UIMessage): Promise<UIMessage> {
    return this._updateMessageInHistory(message);
  }

  /** Refresh Think's live message cache from the durable session path. */
  protected async syncMessagesFromStorage(): Promise<UIMessage[]> {
    return (await this._cfTranscript.sync()).slice();
  }

  /**
   * The turn core shared with `@cloudflare/ai-chat`: the turn queue, abort
   * registry, submit concurrency, continuation slots and barrier, pre-stream
   * set and tool-result apply chain, with the rules that tie them together.
   * The fields below that alias its parts are the same objects.
   */
  private readonly _turns: ChatTurns<Connection> = new ChatTurns<Connection>(
    {
      messages: () => this.messages,
      isReplyStreaming: () => this._turns.liveReply !== null,
      streamingReply: () =>
        this._turns.liveReply?.accumulator.toMessage() ?? null,
      clientToolNames: () => this._requestContext.clientToolNames(),
      clientAnswerableToolNames: () => this._clientAnswerableToolNames(),
      hasActiveStream: () => this._resumableStream.hasActiveStream(),
      generateRequestId: () => crypto.randomUUID(),
      keepAliveWhile: (fn) => this.keepAliveWhile(fn),
      abortRequest: (requestId, reason) => this.abortRequest(requestId, reason),
      // Fired from a timer that may have been armed inside a recovered turn.
      // The continuation is its own turn, not the recovery attempt's.
      fireContinuation: () =>
        this._chatRecoveryEngine().outsideAttempt(
          () => void this._turns.runContinuationTurn(this._continuationTurn())
        ),
      continuationDropped: (event) =>
        this._emit("chat:continuation:dropped", { ...event }),
      stopped: (requestId, reason) => this._afterStop(requestId, reason),
      // A waiting message that will not join: tabs stop drawing it.
      waitingChanged: () => this._broadcastMessages()
    },
    {
      defaultDebounceMs: Think.MESSAGE_DEBOUNCE_MS,
      // A request waiting in the queue survives an isolate reset.
      admissions: {
        store: createChatAdmissionStore(() => this.ctx.storage.sql),
        recoveryPending: () => this._chatRecoveryNames(),
        recoveryOwns: (requestId) => this._chatRecoveryNames(requestId),
        replayRequest: (record) => this._replayClientChatRequest(record)
      }
    }
  );

  /**
   * Whether a chat turn waits for recovery, or, with `requestId`, whether a
   * turn of that request had a fiber recovery knows about.
   */
  private _chatRecoveryNames(requestId?: string): Promise<boolean> {
    return chatRecoveryNames({
      sql: this.ctx.storage.sql,
      storage: this.ctx.storage,
      turnName: (this.constructor as typeof Think).CHAT_FIBER_NAME,
      liveRequestIds: new Set(this._chatTurnFibers.liveTurns.keys()),
      requestId
    });
  }

  /** The app's `onStart` has finished, so replays may run. */
  private _appStartedForAdmissions = false;

  /**
   * Run the requests an earlier isolate left. Never rejects: what fails is
   * logged, and the next start or recovery tries again.
   */
  private _resumeAdmissions(): void {
    // A recovery can settle before the app's `onStart` finished (a facet's
    // legacy fiber recovery runs first). Its replays then wait for the
    // call startup makes once it is done.
    if (!this._appStartedForAdmissions) return;
    void this.keepAliveWhile(() => this._turns.resumeAdmissions()).catch(
      (error) => console.error("[Think] failed to replay requests:", error)
    );
  }

  /**
   * The last message a recovery checks. A request queued behind the
   * recovered turn holds its question on its record until its turn starts,
   * so it is not in the session.
   */
  private _recoveryLeaf(): Promise<{ id: string; role: string } | null> {
    return this.session.getLatestLeaf();
  }

  /**
   * A request an earlier isolate accepted and never gave a turn with a
   * fiber, to run again (`ChatTurns.resumeAdmissions`).
   */
  private _replayClientChatRequest(record: ChatAdmissionRecord) {
    // A record whose payload cannot be read still holds the user's
    // message: it runs as a plain new message, so the message is stored.
    const payload = record.payload as StoredThinkClientRequest | undefined;
    const stored: StoredThinkClientRequest =
      payload && typeof payload === "object"
        ? payload
        : {
            trigger: "submit-message",
            clientTools: undefined,
            body: {},
            originMessageIds: undefined,
            branchParentId: undefined
          };
    const requestId = record.requestId;
    if (stored.originMessageIds) {
      this._frames.requestOrigins.set(requestId, stored.originMessageIds);
    }
    const forget = () => this._frames.requestOrigins.delete(requestId);
    const request = this._clientChatRequest({
      requestId,
      isRegeneration: stored.trigger === "regenerate-message",
      messages: null,
      clientTools: stored.clientTools,
      body: stored.body ?? {},
      connection: null,
      branchParentId: stored.branchParentId,
      originMessageIds: stored.originMessageIds
    });
    const { persist, enqueue } = request;
    return {
      ...request,
      persist: async (context: Parameters<typeof persist>[0]) => {
        const prepared = await persist(context);
        if (prepared === null) forget();
        return prepared;
      },
      enqueue: async (
        turn: () => Promise<void>,
        generation: number,
        onQueued: () => void
      ) => {
        try {
          return await enqueue(turn, generation, onQueued);
        } finally {
          forget();
        }
      }
    };
  }
  private readonly _aborts = this._turns.aborts;
  private readonly _turnQueue = this._turns.queue;
  /**
   * The Streams capability backing `_resumableStream`: chat's in-flight
   * output lives in the shared durable chunk log, readable by any
   * `streams.read()` consumer on this Durable Object.
   */
  readonly streams: Streams = createChatStreams();
  /**
   * Runs each action's side effect once per key (the action ledger) and
   * holds durable-pause approvals. Retention reads the `actionLedger*` and
   * `actionPendingApprovalTtlMs` fields when the capability starts.
   */
  private readonly _approvals: Approvals = new Approvals({
    // Swept by `_sweepApprovals` once rows from an earlier version are in.
    sweepOnStart: false,
    retention: () => ({
      effectSettledMs: this.actionLedgerRetention.settledMs,
      effectPendingMs: this.actionLedgerRetention.pendingMs,
      maxSweepRows: this.actionLedgerRetention.maxSweepRows,
      decisionPendingMs: this.actionPendingApprovalTtlMs
    })
  });

  protected _resumableStream!: ResumableStream;
  private _pendingResumeConnections: Set<string> = new Set();
  /** Where every chat frame to tabs goes out (the shared `ChatFrames`). */
  private readonly _frames = new ChatFrames({
    broadcast: (message, without) => this.broadcast(message, without),
    kv: this.ctx.storage.kv,
    resuming: this._pendingResumeConnections,
    storedOriginIds: (requestId) =>
      this._resumableStream.getOriginMessageIds(requestId),
    recoveryOriginIds: () => this._activeChatRecoveryOriginIds,
    clientView: (messages) => this._turns.clientView(messages)
  });
  /** Lazily-built shared resume-handshake driver (Tier-2). */
  private _resumeHandshakeInstance: ResumeHandshake | null = null;
  /**
   * The stored request context (the shared `ChatRequestContext`): the client
   * tools and body of the most recent chat request, which continuations and
   * recoveries run with. It owns when they change and writes them to
   * `think_config`, skipping a value equal to what is stored.
   */
  private readonly _requestContext = new ChatRequestContext({
    get: (key) => this._cfConfig.get(key),
    set: (key, json) => this._cfConfig.set(key, json),
    delete: (key) => this._cfConfig.delete(key)
  });
  private get _lastClientTools(): ClientToolSchema[] | undefined {
    return this._requestContext.clientTools;
  }
  private set _lastClientTools(clientTools: ClientToolSchema[] | undefined) {
    this._requestContext.clientTools = clientTools;
  }
  private get _lastBody(): Record<string, unknown> | undefined {
    return this._requestContext.body;
  }
  private set _lastBody(body: Record<string, unknown> | undefined) {
    this._requestContext.body = body;
  }
  private readonly _continuation = this._turns.continuation;
  /**
   * Accepted-but-not-yet-streamed turns and the connections parked waiting for
   * one (#1784). See {@link ResumeHandshake} `preStream`.
   *
   * HIBERNATION INVARIANT: in-memory only, NOT persisted. Safe because the
   * pre-stream window cannot overlap hibernation — a turn between `begin()` and
   * stream start is an unresolved `onMessage` handler promise that pins the DO,
   * so eviction only happens once a durable stream exists (resumed via
   * `ResumableStream`) or the turn finished. Breaks if a pre-stream wait is ever
   * moved onto a durable alarm that releases the DO; if so, persist this state.
   */
  private readonly _preStream = this._turns.preStream;
  // Shared auto-continuation barrier (#1649 / #1650): owns the coalesce timer
  // and the double-fire guard.
  private readonly _autoContinuation = this._turns.autoContinuation;
  private _insideResponseHook = false;
  private _insideInferenceLoop = false;
  private get _pendingInteractionPromise(): Promise<boolean> | null {
    return this._turns.pendingInteraction;
  }
  private set _pendingInteractionPromise(value: Promise<boolean> | null) {
    this._turns.pendingInteraction = value;
  }
  // Serialization tail for client-tool result/approval applies (#1649). Each
  // apply is a read-modify-write of the full message; running siblings from a
  // parallel tool batch concurrently lets last-write-wins clobber the others
  // back to `input-available`. Chaining every apply off this tail makes them
  // commit atomically in arrival order.
  private get _interactionApplyTail(): Promise<void> {
    return this._turns.interactionTail;
  }
  private set _interactionApplyTail(value: Promise<void>) {
    this._turns.interactionTail = value;
  }
  /** The stream every reply writes (`pumpReply`). */
  private readonly _replyStreams = new ReplyStreams({
    resumable: () => this._resumableStream,
    streamStarted: (requestId) =>
      this._turns.streamStarted(requestId, (c) =>
        this._notifyStreamResuming(c)
      ),
    // A connection offered the stream that never ACKed (`resume: false`, or
    // gone quiet) must still get the terminal frame and every later
    // broadcast.
    streamEnded: (requestId) => {
      this._pendingResumeConnections.clear();
      this._turns.streamEnded(requestId);
    },
    originMessageIds: (requestId) =>
      this._frames.requestOrigins.get(requestId) ??
      this._activeChatRecoveryOriginIds,
    transaction: (fn) => this.ctx.storage.transactionSync(fn),
    record: (requestId, result) =>
      this._recordSubmissionTurnResult(requestId, result)
  });
  // Resolved pauses, by tool call id, whose outcome write or generation drop
  // may not have landed: the outcome is being written, or its own turn was
  // still streaming. See `_dropGenerationAfterResolvedPause`. Mirrored in
  // storage with the outcome so both survive a restart before the next turn;
  // loaded once per isolate.
  private _deferredResolvedPauses = new Map<string, ResolvedPauseOutcome>();
  private _deferredResolvedPausesLoad: Promise<void> | undefined;
  private readonly _submitConcurrency = this._turns.submits;
  private static MESSAGE_DEBOUNCE_MS = 750;
  /**
   * Everything this agent does when a parent runs it as a tool: the run
   * table, the run's life, what the parent reads, and progress. Shared with
   * `@cloudflare/ai-chat`; this class supplies only what differs.
   */
  private readonly _agentToolRuns = new AgentToolRuns({
    store: createAgentToolRunStore(() => this.ctx.storage.sql, {
      runs: "cf_agent_tool_child_runs",
      milestones: "cf_agent_tool_milestones",
      requestIndex: "idx_agent_tool_child_runs_request_id"
    }),
    streams: () => this._resumableStream,
    storage: () => this.ctx.storage,
    responseType: MSG_CHAT_RESPONSE,
    resetError: "Agent tool run was skipped before the child could finish.",
    keepAliveWhile: (fn) => this.keepAliveWhile(fn),
    generateRequestId: () => crypto.randomUUID(),
    activeRequestId: () => admittedTurnContext.getStore()?.requestId,
    broadcastChunk: (requestId, body) =>
      this._frames.broadcast({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body,
        done: false
      }),
    collectResult: (runId) => {
      const output = this.getAgentToolOutput(runId);
      return { output, summary: this.getAgentToolSummary(runId, output) };
    },
    messages: () => this.messages,
    // The same as a client's stop for the request (#1630).
    cancelRequest: (requestId, reason) =>
      this.cancelChat(requestId, abortReasonText(reason) ?? undefined)
  });
  private _submissionTableEnsured = false;
  private _actionPendingTableEnsured = false;
  private _submissionAbortControllers = new Map<string, AbortController>();
  private _submissionsApplyingMessages = new Set<string>();
  private _programmaticStreamErrors = new Map<string, string>();
  protected static submissionRecoveryStaleMs = 15 * 60 * 1000;

  override broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    // A chunk of a terminal-only agent-tool run is forwarded to the run's
    // tailers, not broadcast.
    if (this._agentToolRuns.intercept(msg)) return;
    super.broadcast(msg, without);
  }

  // ── Dynamic config ──────────────────────────────────────────────

  #configCache: unknown = null;

  /**
   * Persist an arbitrary JSON-serializable configuration object for this
   * agent instance. Stored in the Think-private `think_config` table —
   * survives
   * restarts and hibernation. Pass the config shape as a method generic
   * for typed call sites:
   *
   * ```ts
   * this.configure<MyConfig>({ modelTier: "fast" });
   * ```
   *
   * Prefer `state` / `setState` from `Agent` when you want the value
   * broadcast to connected clients. Use `configure` for private
   * per-instance config that should stay server-side.
   */
  configure<T = Record<string, unknown>>(config: T): void {
    const json = JSON.stringify(config);
    this._cfConfig.set("_think_config", json);
    this.#configCache = config;
  }

  /**
   * Read the persisted configuration, or null if never configured.
   * Pass the config shape as a method generic for a typed result:
   *
   * ```ts
   * const cfg = this.getConfig<MyConfig>();
   * ```
   */
  getConfig<T = Record<string, unknown>>(): T | null {
    if (this.#configCache !== null) return this.#configCache as T;
    const raw = this._cfConfig.get("_think_config");
    if (raw !== undefined) {
      this.#configCache = JSON.parse(raw);
      return this.#configCache as T;
    }
    return null;
  }

  // ── Config storage helpers (think_config table) ─────────────────

  /** Messenger replies as Task runs. */
  readonly #messengerReplies: MessengerReplies;

  /** Think's private keyed config rows. */
  private readonly _cfConfig = new ThinkConfigStore();

  /**
   * Run the legacy `assistant_config` lift again. The config capability runs
   * it on start; this is a test seam, not an override point.
   * @internal
   */
  protected _migrateLegacyConfigToThinkTable(): void {
    this._cfConfig.migrateLegacy();
  }

  // ── Configuration overrides ─────────────────────────────────────

  /**
   * Return the model to use for inference. Must be overridden by subclasses.
   *
   * The return value can be either:
   *
   * - A **string** model id, resolved through the built-in
   *   {@link https://www.npmjs.com/package/workers-ai-provider | workers-ai-provider}
   *   off your `AI` binding (see {@link getAIBinding}). A `@cf/...` id hits
   *   Workers AI directly; any other `"<provider>/<model>"` slug — e.g.
   *   `"openai/gpt-5.5"`, `"anthropic/claude-sonnet-4-5"`, `"google/gemini-2.5-pro"`
   *   — is routed through AI Gateway with resumable streaming on by default.
   *   This is the common case: no extra package to install, no provider to wire.
   * - A fully-constructed AI SDK `LanguageModel`, for any other provider or for
   *   full control over provider/gateway options.
   *
   * @example String (Workers AI)
   * ```typescript
   * getModel() {
   *   return "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
   * }
   * ```
   *
   * @example String (third-party via AI Gateway)
   * ```typescript
   * getModel() {
   *   return "openai/gpt-5.5";
   * }
   * ```
   *
   * @example Bring your own provider
   * ```typescript
   * import { createOpenAI } from "@ai-sdk/openai";
   * getModel() {
   *   return createOpenAI({ apiKey: this.env.OPENAI_API_KEY })("gpt-5.5");
   * }
   * ```
   */
  getModel(): ThinkModel {
    throw new Error(
      "Override getModel() to return a model id string (e.g. " +
        '"@cf/deepseek-ai/deepseek-v4.1-flash-1017" or "openai/gpt-5.5") or a LanguageModel.'
    );
  }

  /**
   * Return the Workers AI binding used by the built-in default provider when
   * {@link getModel} returns a string. Defaults to `this.env.AI`. Override if
   * your binding is named something other than `AI`.
   */
  getAIBinding(): Ai {
    const binding = (this.env as { AI?: Ai }).AI;
    if (!binding) {
      throw new Error(
        "Think's default model provider needs a Workers AI binding named " +
          '"AI". Add `"ai": { "binding": "AI" }` to wrangler.jsonc, override ' +
          "getAIBinding() to return your binding, or override getModel() to " +
          "return a LanguageModel."
      );
    }
    return binding;
  }

  /** Builds string models through one cached default provider. */
  readonly #models = new ThinkModelResolver({
    binding: () => this.getAIBinding(),
    gateway: (model) => this.getGateway(model),
    sessionAffinity: () => this.sessionAffinity
  });

  /**
   * Return AI Gateway options for a string model resolved by the default
   * provider. Called on every {@link resolveModel} call: once per turn for the
   * default model (skipped when `beforeTurn` returns its own `model` without
   * reading `ctx.model`), plus once for each string `model` override returned
   * from `beforeTurn` or `beforeStep`. It can read {@link activeTurn}, the
   * messenger context, or agent state. Use it to pick a gateway `id` and to
   * attach `metadata`, which AI Gateway records on the request log as
   * `cf-aig-metadata`. It must return synchronously; a returned Promise is
   * rejected with an error.
   *
   * Defaults to `undefined`: catalog slugs use the account's `default`
   * gateway, and `@cf/...` ids call Workers AI without a gateway. Not called
   * for a model that is already a `LanguageModel`.
   */
  getGateway(_model: string): GatewayOptions | undefined {
    return undefined;
  }

  /**
   * Resolve a model value into a concrete AI SDK `LanguageModel`.
   *
   * Defaults to resolving {@link getModel}. A `LanguageModel` is returned as-is;
   * a string is built through the bundled default provider (see {@link getModel}
   * for the slug rules). Use this whenever you need a usable model outside the
   * main turn — e.g. a side `generateText` call for summarization/compaction —
   * since `getModel()` may return a bare string.
   */
  resolveModel(model: ThinkModel = this.getModel()): LanguageModel {
    return this.#models.resolve(model);
  }

  /**
   * Return the instructions at the top of the system prompt.
   *
   * An override always comes first, followed by the context blocks from
   * `configureContext()`, skills, and extensions. Think's default text is
   * used only when the agent overrides nothing and has no context blocks.
   */
  getSystemPrompt(): string {
    return [
      "You are a careful, capable assistant helping the user complete their task.",
      "Use available tools when they materially improve accuracy or let you act on the user's request. Before changing code, understand the relevant context: existing patterns, dependencies, tests, and nearby conventions.",
      "Keep changes focused on the user's request. Prefer small, idiomatic edits over broad rewrites or new abstractions. Do not introduce new dependencies, secrets, destructive actions, or persistent side effects unless the user clearly asks or approves.",
      "When the task is complex, briefly state your approach and keep the user informed with concise progress updates. If you modify code, verify with the smallest relevant test, build, typecheck, lint, or runtime check available, and report any checks you could not run.",
      "Be direct and useful in your final response: summarize the outcome, mention important files or commands, and call out real blockers or risks."
    ].join("\n\n");
  }

  /**
   * The base system prompt for a turn: an overridden `getSystemPrompt()`,
   * then the frozen context blocks. Think's default `getSystemPrompt()` is
   * only a fallback for an agent with no context blocks.
   *
   * @internal Exposed to subclasses for tests.
   */
  protected async _buildBaseSystemPrompt(): Promise<string> {
    const blocks = await this.context.freezeSystemPrompt();
    if (!isMethodOverridden(this, "getSystemPrompt")) {
      return blocks || this.getSystemPrompt();
    }
    return [this.getSystemPrompt(), blocks]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");
  }

  /** Return the tools available to the assistant. */
  getTools(): ToolSet {
    return {};
  }

  /** Return action descriptors compiled into tools for the assistant. */
  getActions(): Record<string, Action> | Promise<Record<string, Action>> {
    return {};
  }

  /** Return messenger integrations that should be routed through this Think agent. */
  getMessengers(): ThinkMessengers {
    return {};
  }

  /**
   * Return the channels for this agent. Wraps (does not supersede)
   * {@link getMessengers}: the implicit `web` channel is always present, each
   * messenger from `getMessengers()` is absorbed as a `kind: "messenger"`
   * channel, and these entries add `web`/`voice`/`custom` surfaces plus
   * per-channel policy. A channel id that collides with a `getMessengers()` id
   * is an error.
   */
  configureChannels(): ThinkChannels | Promise<ThinkChannels> {
    return {};
  }

  getMessengerContext(): MessengerContext | undefined {
    const active = this._activeMessengerContext();
    if (active) {
      return active;
    }

    const message = this.messages.at(-1) as
      | (UIMessage & { metadata?: { messenger?: MessengerContext } })
      | undefined;
    return message?.metadata?.messenger;
  }

  private _activeMessengerContext(): MessengerContext | undefined {
    const store = messengerTurnContext.getStore();
    return store?.agent === this && !store.ended ? store.context : undefined;
  }

  async chatWithMessengerContext(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
    options?: ChatOptions
  ): Promise<void> {
    // Async work the turn leaves behind keeps this store, so it is marked
    // ended rather than trusted to go out of scope.
    const store = { agent: this, context, ended: false };
    try {
      await messengerTurnContext.run(store, () =>
        this.chat(userMessage, callback, {
          ...options,
          channel: context.messengerId
        })
      );
    } finally {
      store.ended = true;
    }
  }

  /**
   * The turn currently running on this agent, readable from `beforeTurn`,
   * `beforeToolCall`, tool `execute`, `onChatResponse` and anything they call.
   * Undefined outside a turn, including from code a turn scheduled to run
   * later.
   */
  get activeTurn(): ActiveTurn | undefined {
    const turn = this._activeAdmittedTurn();
    if (!turn) return undefined;
    return {
      requestId: turn.requestId,
      trigger: turn.trigger,
      continuation: turn.continuation ?? false,
      ...(turn.channel !== undefined && { channel: turn.channel })
    };
  }

  /** The admitted-turn store of the turn running now, if the caller is in it. */
  private _activeAdmittedTurn() {
    const turn = admittedTurnContext.getStore();
    if (!turn || turn.agent !== this) return undefined;
    // The store outlives the turn in any async work the turn scheduled.
    if (this._turnQueue.activeRequestId !== turn.requestId) return undefined;
    return turn;
  }

  /**
   * Bind the live messenger delivery surface for the active turn so
   * `deliverNotice` can post to the originating channel while a messenger turn
   * is running. Returns a restore function; save/restore keeps nested turns
   * safe. Called by `deliverMessengerReply`.
   */
  bindActiveDeliverySurface(surface: MessengerDeliverySurface): () => void {
    const previous = this._activeDeliverySurface;
    this._activeDeliverySurface = surface;
    return () => {
      this._activeDeliverySurface = previous;
    };
  }

  /**
   * The channel context for the active turn, if the turn resolved to a channel.
   * Readable from tools/hooks during a turn (e.g. to branch on `kind`).
   * Undefined outside a turn, like {@link activeTurn} — including from work a
   * turn left behind that runs while a later turn holds another channel.
   */
  get activeChannel(): ChannelContext | undefined {
    const turn = this._activeAdmittedTurn();
    const context = this._activeChannelContext;
    return turn && context?.channelId === turn.channel ? context : undefined;
  }

  /**
   * The server-supplied metadata stamped on the active turn's user message
   * ({@link ChatOptions.metadata}). Like the channel stamp, it is persisted on
   * the durable user message, so recovered/continued turns re-resolve the same
   * value; client-supplied message metadata can never populate it (reserved
   * keys are stripped at intake). `undefined` when the turn carried none.
   */
  get activeTurnMetadata(): Record<string, unknown> | undefined {
    return turnMetadataFromMessages(this.messages);
  }

  /**
   * Run `fn` with the turn-scoped channel context set for `channel`. No-op (just
   * runs `fn`) when the channel is unset or unregistered. Save/restore keeps
   * nested turns safe — mirrors `chatWithMessengerContext`.
   */
  private async _withChannelContext<T>(
    channel: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    const context = resolveChannelContext(channel, {
      registry: this._channels,
      requestId: admittedTurnContext.getStore()?.requestId,
      messengerContext: () => this.getMessengerContext(),
      emit: (event) => this._emitChannelEvent(event)
    });
    if (!context) {
      return fn();
    }
    const previous = this._activeChannelContext;
    this._activeChannelContext = context;
    try {
      return await fn();
    } finally {
      this._activeChannelContext = previous;
    }
  }

  private _channelForAutoContinuation(): string | undefined {
    return this._lastTurnChannel
      ? this._lastTurnChannel.channel
      : channelFromMessages(this.messages);
  }

  /**
   * Deliver a no-turn, channel-routed message — a deterministic status, fallback,
   * or notice — straight to the channel's delivery surface WITHOUT invoking the
   * model and WITHOUT opening a recovery incident.
   *
   * Routing precedence for the target channel: explicit `options.channel` → the
   * active turn's channel → `"web"`. The `web` channel renders via the transcript
   * (its only client render path), so a web notice is always transcript-visible;
   * messenger/voice deliver out of band and only touch the transcript when
   * `informModel: true`.
   *
   * Like `addMessages`, this bypasses the turn queue and is safe to call from
   * inside a tool `execute` without deadlocking.
   */
  async deliverNotice(
    text: string | { markdown: string },
    options?: DeliverNoticeOptions
  ): Promise<void> {
    const channelId = options?.channel ?? this._activeChannelId() ?? "web";
    await deliverChannelNotice(text, options, {
      channelId,
      registry: this._channels,
      surface: async () =>
        this._activeDeliverySurface ??
        (await this._messengerRuntime?.resolveDeliverySurface(
          channelId,
          options?.thread
        )),
      addMessages: (messages) => this.addMessages(messages),
      emit: (event) => this._emitChannelEvent(event)
    });
  }

  /**
   * Post a recovered messenger reply, or the interrupted apology, to a thread.
   * Called by a conversation sub-agent (or this agent) once chat recovery of
   * an interrupted messenger turn settles; only the host holds the messenger
   * runtime (#2106).
   *
   * @internal
   */
  async _cf_deliverRecoveredMessengerReply(input: {
    messengerId: string;
    threadId: string;
    outcome: "completed" | "interrupted";
    text?: string;
    partialPosted?: boolean;
    chunk: number;
  }): Promise<{ chunks: number }> {
    if (!this._messengerRuntime) {
      throw new Error(
        `Cannot deliver a recovered reply for messenger "${input.messengerId}": this agent has no messenger runtime`
      );
    }
    return this._messengerRuntime.deliverRecoveredReply(input);
  }

  /**
   * The active turn's channel id, if any. Prefers the turn-scoped channel
   * context, then the active messenger turn's id; web turns have none, so
   * `deliverNotice` defaults to `"web"`.
   */
  private _activeChannelId(): string | undefined {
    return (
      this.activeChannel?.channelId ??
      this._activeMessengerContext()?.messengerId
    );
  }

  private async _initializeChannels(): Promise<void> {
    if (this.parentPath.length > 0) {
      return;
    }

    const configured = await this.configureChannels();
    const messengers = this.getMessengers();
    const { channels, messengers: messengerDefs } = resolveChannels(
      configured,
      messengers
    );
    this._channels = channels;

    if (Object.keys(messengerDefs).length === 0) {
      return;
    }

    this._messengerRuntime = new ThinkMessengerRuntime(
      messengerDefs,
      this as unknown as MessengerThinkHost,
      { concurrency: this.messengerConcurrency }
    );
    this._messengerRuntime.initialize();
  }

  /** Return code-declared scheduled tasks for this agent. */
  getScheduledTasks(): ThinkScheduledTasks | Promise<ThinkScheduledTasks> {
    return {};
  }

  /**
   * Reconcile code-declared scheduled tasks immediately.
   * Static declarations are reconciled on startup automatically; call this
   * after changing app-owned data that `getScheduledTasks()` reads.
   */
  internal_reconcileScheduledTasks(): Promise<void> {
    const ownerKey = stableHash(this.selfPath);
    return declareSchedules(
      this.scheduler,
      async () =>
        toDeclaredSchedules(
          await this.getScheduledTasks(),
          ownerKey,
          (messages, options) => this.submitMessages(messages, options)
        ),
      {
        group: "think",
        defaultTimezone: () => this.getDefaultTimezone(),
        idempotencyKeyPrefix: `think-schedule:${ownerKey}`
      }
    );
  }

  /**
   * Return the default timezone for wall-clock scheduled tasks.
   * Task-local timezone declarations take precedence.
   */
  getDefaultTimezone(): string | undefined | Promise<string | undefined> {
    return undefined;
  }

  /**
   * Live chat-turn closures keyed by run nonce. A closure exists only in the
   * isolate that accepted the turn; recovery after interruption never re-runs
   * it — the definition's `recover` callback hands the interruption to the
   * shared ChatRecoveryEngine instead.
   */
  /**
   * Start time and latest `stash()` data of each chat turn running in this
   * isolate, keyed by request id. A stream stall is recovered while the turn is
   * still live, so `onChatRecovery` reads these instead of a fiber snapshot.
   */
  private get _liveChatRecoveryTurns() {
    return this._chatTurnFibers.liveTurns;
  }

  private get _liveChatTurnClosures() {
    return this._chatTurnFibers.liveClosures;
  }

  /** Runs each chat turn as a durable fiber. Shared with `AIChatAgent`. */
  private readonly _chatTurnFibers = new ChatTurnFibers({
    fiberName: (this.constructor as typeof Think).CHAT_FIBER_NAME,
    snapshotKey: "__cfThinkChatFiberSnapshot",
    generateId: () => crypto.randomUUID(),
    turnSignal: (requestId) => this._turns.aborts.getExistingSignal(requestId),
    runTask: ({ requestId, continuation, nonce }) =>
      this.tasks.__DO_NOT_USE_WILL_BREAK__runAttached(
        (this.constructor as typeof Think).CHAT_FIBER_NAME,
        { requestId, continuation, nonce },
        { runId: `chat_${nonce}`, retain: false, metadata: { requestId } }
      ),
    captureContext: () => {
      const ambient = agentContext.getStore();
      return (fn) => (ambient ? agentContext.run(ambient, fn) : fn());
    },
    turnBody: (continuation, body, requestId) =>
      this._chatRecoveryEngine().turnBody(continuation, body, requestId),
    turnAccepted: (requestId) => this._turns.turnAccepted(requestId),
    inRecoveryAttempt: () => this._chatRecoveryEngine().inAttempt
  });

  /**
   * Register the shared chat-turn Task definition (see
   * `agents/chat` `createChatTurnTaskDefinition` for the turn logic): the
   * host wires its protected internals through the hooks.
   */
  private _registerChatTurnTaskDefinition(): void {
    const chatFiberName = (this.constructor as typeof Think).CHAT_FIBER_NAME;
    this.tasks.register(
      chatFiberName,
      createChatTurnTaskDefinition({
        storage: this.ctx.storage,
        getRunCreatedAt: async (runId) =>
          (await this.tasks.get(runId))?.createdAt ?? null,
        getLiveClosure: (nonce) => this._liveChatTurnClosures.get(nonce),
        keepAliveWhile: (fn) => this.keepAliveWhile(fn),
        withStash: (context, fn) => this._withFiberStash(context, fn),
        recover: (turn) => this._recoverChatTurn(turn)
      })
    );
  }

  /** Register the shared Tasks transport for recovery continuations. */
  private _registerChatRecoveryTaskDefinition(): void {
    // SAFETY: the recovery engine is the sole producer of each callback's
    // payload and the Task persists it verbatim, so the callback name selects
    // the matching host input type.
    this.tasks.register(
      CHAT_RECOVERY_TASK_NAME,
      createChatRecoveryTaskDefinition({
        _chatRecoveryContinue: (data) =>
          this._chatRecoveryContinue(data as ChatRecoveryContinueData),
        _chatRecoveryRetry: (data) =>
          this._chatRecoveryRetry(data as ChatRecoveryRetryData)
      })
    );
  }

  /** Enqueue one recovery attempt on the shared Tasks transport. */
  private _enqueueChatRecovery(
    callback: ChatRecoveryScheduleCallback,
    data: Record<string, unknown>,
    reason: ChatRecoveryTaskReason,
    delaySeconds: number,
    dedupeKey?: string
  ): Promise<void> {
    return enqueueChatRecoveryTask(
      this.tasks,
      { callback, data, delaySeconds },
      reason,
      dedupeKey
    );
  }

  /**
   * Host seam for {@link ThinkMessengerRuntime}: durably accept one reply
   * run on the Tasks capability and execute it inline while this isolate
   * lives.
   * @internal
   */
  _runMessengerReplyTask(input: {
    nonce: string;
    idempotencyKey: string;
    metadata: Record<string, unknown>;
  }): Promise<{ accepted: boolean }> {
    return this.#messengerReplies.run(input);
  }

  private _runChatRecoveryFiber<T>(
    requestId: string,
    continuation: boolean,
    fn: (takeReply: () => Promise<void>) => Promise<T>,
    branchParentId?: string,
    // The tools and body the turn runs with, for its recovery snapshot. Left
    // out by a turn that runs with the stored ones.
    context?: {
      clientTools: ClientToolSchema[] | undefined;
      body: Record<string, unknown> | undefined;
    }
  ): Promise<T> {
    // A recovered turn tells its attempt when its fiber is durably accepted,
    // so the attempt can move a submission it owns to this turn.
    const acceptance = recoveredTurnAcceptanceContext.getStore();
    const snapshot: ThinkChatFiberSnapshot = {
      ...createChatFiberSnapshot({
        kind: "think-chat-turn",
        requestId,
        recoveryRootRequestId:
          this._activeChatRecoveryRootRequestId ?? requestId,
        continuation,
        messages: this.messages,
        lastBody: context ? context.body : this._lastBody,
        lastClientTools: context ? context.clientTools : this._lastClientTools,
        originMessageIds: this._frames.originIds(requestId)
      }),
      ...(branchParentId !== undefined && { branchParentId })
    };
    return this._chatTurnFibers.run(
      {
        requestId,
        continuation,
        snapshot,
        onAccepted:
          acceptance?.agent === this ? acceptance.onAccepted : undefined
      },
      fn
    );
  }

  /** Maximum number of tool-call steps per turn. Override via property or per-turn via TurnConfig. */
  maxSteps = 10;

  /**
   * Read-time truncation moves its cutoff once every this many messages, so
   * the provider's cached prompt prefix survives the turns in between. Up to
   * `truncationStep + 3` recent messages stay at full fidelity. Set it to `1`
   * to cut every turn, which keeps the fewest full-fidelity messages for
   * models with a small context window. `Infinity` never moves the cutoff, so
   * read-time truncation is off and every message stays at full fidelity;
   * media eviction then keeps exactly `keepRecentMessages` and rewrites the
   * prefix whenever a message ages out. Other non-finite or non-positive
   * values behave like `1`.
   *
   * @default 8
   */
  truncationStep = MODEL_TRUNCATION_STEP;

  /**
   * Retention window for settled action ledger rows. Deleting a row ends the
   * idempotency guarantee for that key, so increase these windows for side
   * effects whose downstream idempotency horizon is longer. Set a status to
   * `false` to disable sweeping it.
   */
  actionLedgerRetention: ActionLedgerRetentionConfig = {
    settledMs: 30 * 24 * 60 * 60 * 1000,
    pendingMs: 90 * 24 * 60 * 60 * 1000,
    maxSweepRows: 500
  };

  /**
   * Lease window after which a durable `pending` action ledger row is assumed
   * abandoned (its executor isolate died) and may be reclaimed and re-run.
   * Reclaim re-runs `execute`, so it only applies to actions that declare an
   * explicit `idempotencyKey` — that key is the developer's assertion that the
   * keyed side effect is safe to retry. Fallback `tool:${toolCallId}` keys are
   * never reclaimed. Set to `false` to disable stale-pending reclaim entirely
   * (a stale row then blocks forever with `ActionPendingError`, the old
   * behavior). This is a retry lease, not a retention window: retention answers
   * "when may we delete old rows?"; the lease answers "when may we assume the
   * previous executor died and retry safely?". Keep `actionLedgerRetention.pendingMs`
   * well above this lease so reclaim happens before a sweep deletes the row.
   */
  actionLedgerPendingRetryLeaseMs: number | false = 5 * 60 * 1000;

  /**
   * Retention window for abandoned durable-pause approval rows — a
   * `kind: "durable-pause"` action that parked but was never approved or
   * rejected. Deleting a row makes that approval permanently unresolvable, so
   * default generously: "approve days later from a dashboard" is the use case.
   * Set to `false` to disable sweeping. Rows are deleted promptly on
   * approve/reject regardless; this only bounds truly abandoned pauses.
   */
  actionPendingApprovalTtlMs: number | false = 30 * 24 * 60 * 60 * 1000;

  /**
   * Whether reasoning chunks are sent to chat clients by default. Override
   * per turn by returning `sendReasoning` from `beforeTurn`.
   */
  sendReasoning = true;

  /**
   * Default writer for server-authored assistant-message metadata, applied to
   * every turn. Override (or supply) per turn by returning `messageMetadata`
   * from `beforeTurn` ({@link TurnConfig.messageMetadata}). Set this when the
   * metadata is turn-independent — e.g. stamping a `createdAt` timestamp on
   * every assistant message — so callers need not repeat it in `beforeTurn`.
   * See {@link MessageMetadataCallback} for when it is called and the
   * serialization constraints on its return value.
   */
  messageMetadata?: MessageMetadataCallback;

  /**
   * Inactivity watchdog for the streaming read loop, in milliseconds.
   *
   * If a turn's model stream produces no chunk for this long, the watchdog
   * aborts the turn and surfaces a terminal stream error instead of letting the
   * loop park forever on a hung provider/transport (the "infinite spinner"
   * failure: the stream never throws, so no error and no `done` ever arrives).
   * A `chat:stream:stalled` observability event is emitted when it fires.
   *
   * This measures the gap *between UI-message-stream chunks*, which includes
   * time spent executing server-side tools (no chunks flow while a tool runs).
   * Set it comfortably above your slowest expected model time-to-first-token
   * and your slowest tool execution, or you will abort healthy long turns.
   *
   * Default `0` (disabled) — opt in by setting a value (e.g. `120_000`).
   *
   * Can be overridden per-turn via `TurnConfig.chatStreamStallTimeoutMs`
   * (returned from `beforeTurn`) for turns with known-slow tools.
   */
  chatStreamStallTimeoutMs = 0;

  /**
   * Per-turn stall-watchdog timeout resolved from `TurnConfig` in
   * `_runInferenceLoop`, read by the stream loop when arming the watchdog.
   * `undefined` falls back to the instance-level `chatStreamStallTimeoutMs`.
   * Turns are serialized, so a single active value is safe; it is reset at the
   * top of every `_runInferenceLoop`.
   */
  private _activeStallTimeoutMs: number | undefined;

  // ── Context-overflow handling (opt-in) ────────────────────────────
  //
  // Compaction normally only fires between turns (Session.compactAfter checks
  // the threshold on appendMessage). But a single long, tool-heavy turn grows
  // the prompt step-by-step inside one streamText loop and can exceed the
  // model's context window *mid-turn*, before the next pre-turn check — the
  // provider then 400s ("prompt is too long" / context_length_exceeded). The
  // `contextOverflow` config lets Think recover without baking provider
  // knowledge into core: the app classifies the error (`classifyChatError`),
  // Think reacts.

  /**
   * Opt-in handling for a turn that overflows the context window mid-flight.
   * See {@link ContextOverflowConfig}. Unset (the default) leaves the existing
   * terminal behavior unchanged.
   *
   * @example
   * ```typescript
   * override contextOverflow = {
   *   reactive: true,
   *   proactive: { maxInputTokens: 200_000 }
   * };
   * ```
   */
  contextOverflow?: ContextOverflowConfig;

  /** Error classification and context-overflow recovery for each turn. */
  readonly #overflow = new ThinkContextOverflow({
    config: () => this.contextOverflow,
    classifierOverridden: () => isMethodOverridden(this, "classifyChatError"),
    classify: (error, ctx) => this.classifyChatError(error, ctx),
    compact: () => this.session.compact(this._turnHistoryLeafId),
    emit: (type, payload) => this._emit(type, payload),
    onChatError: (error, ctx) => this.onChatError(error, ctx),
    rebuildMessages: async () =>
      // The compaction refreshed the stored prompt, but this request keeps
      // the system prompt it started with, so it still needs the reminder.
      withContextReminder(
        await this._assembleModelMessages(this._activeTurnTools),
        this._turnContextReminder
      )
  });

  private get _overflowReactiveEnabled(): boolean {
    return this.#overflow.reactiveEnabled;
  }

  private get _overflowMaxRetries(): number {
    return this.#overflow.maxRetries;
  }

  /** The context reminder the current turn was assembled with. */
  private _turnContextReminder: string | null = null;

  /**
   * The last message the current turn's model history reaches, when that is
   * not the leaf: a regeneration answers its parent user message, so the
   * response it replaces (a stored sibling branch) stays out of the prompt.
   */
  private _turnHistoryLeafId: string | undefined;

  /**
   * The assembled tool set for the current turn, captured in
   * `_runInferenceLoop`. The proactive guard reuses it to convert the
   * recompacted history through the same `convertToModelMessages` tool schemas.
   * Turns are serialized, so a single value is safe.
   */
  private _activeTurnTools: ToolSet = {};
  private _activeTurnActionMetadata = new Map<string, CompiledActionMetadata>();
  private _activeTurnAuthorization: NormalizedActionAuthorization = {
    allowed: true
  };
  private _activeTurnActionApprovalDescriptors = new Map<
    string,
    ActionApprovalDescriptor
  >();
  private _activeTurnApprovedActionInputs = new Map<string, unknown>();
  /**
   * Advisory reply attachments recorded by actions during the current admitted
   * turn (see `ctx.attachReply`). Single-slot because turns are serialized.
   * Reset at turn start in `_runInsideAdmittedTurnBody`; intentionally not
   * cleared at turn end so `onChatResponse` and `replyAttachments()` can read
   * it — the next turn's reset overwrites it.
   */
  private _activeTurnReplyAttachments: ReplyAttachment[] = [];
  private _activeTurnReplyAttachmentsRequestId: string | undefined;

  /**
   * Configure conversation storage. Called once during `onStart`. Override to
   * set the compaction policy; prompt context is declared by
   * {@link Think.configureContext} instead.
   *
   * The handle still accepts the pre-Sessions `withContext()` and
   * `withCachedPrompt()` chain, so an existing override keeps working; those
   * blocks are appended after the ones `configureContext()` returns.
   *
   * @example
   * ```typescript
   * configureSession(session: Session) {
   *   return session
   *     .onCompaction(createCompactFunction({ summarize }))
   *     .compactAfter(80_000);
   * }
   * ```
   */
  configureSession(
    session: ThinkSession
  ): ThinkSession | Promise<ThinkSession> {
    return session;
  }

  /**
   * Declare the prompt context blocks for this agent.
   *
   * Blocks render into the system prompt and, when their provider is
   * writable, give the model `set_context` to update them. A block declared
   * without a provider is auto-wired to durable per-agent SQLite storage.
   *
   * @example
   * ```typescript
   * configureContext(): ContextConfig[] {
   *   return [
   *     { label: "soul", provider: { get: async () => "You are helpful." } },
   *     { label: "memory", description: "Learned facts", maxTokens: 2000 }
   *   ];
   * }
   * ```
   */
  configureContext(): ContextConfig[] | Promise<ContextConfig[]> {
    return [];
  }

  /**
   * Return Agent Skills sources for this Think agent.
   *
   * A skill is a directory with a `SKILL.md` file, as defined by
   * https://agentskills.io. Keep skills as files in the agent's Workspace
   * and they become available as soon as they are written:
   *
   * ```typescript
   * getSkills() {
   *   return [skills.workspace(this.workspace)]; // /workspace/.agents/skills
   * }
   * ```
   *
   * `skills.r2()` reads skills from an R2 bucket and `skills.manifest()`
   * defines them in code. Sources are applied in order; the first source to
   * provide a skill name wins, and later collisions are skipped with a
   * logged warning. Sources are listed again before every turn.
   */
  getSkills(): SkillSource[] | Promise<SkillSource[]> {
    return [];
  }

  /**
   * Return an optional runner that enables the `run_skill_script` tool.
   *
   * Prefer keeping skills in the Workspace and letting the agent run their
   * scripts with its shell tools.
   *
   * @experimental Skill script execution is experimental and may change
   * before stabilizing.
   */
  getSkillScriptRunner(): SkillScriptRunner | null {
    return null;
  }

  /**
   * Return sandboxed extension configurations. Defines load order,
   * which determines hook execution order.
   * Requires `extensionLoader` to be set.
   */
  getExtensions(): ExtensionConfig[] {
    return [];
  }

  // ── Lifecycle hooks ───────────────────────────────────────────

  /**
   * Called before `streamText` — inspect the assembled context and
   * return overrides. Think assembles tools, system prompt, and messages
   * internally; this hook sees the result and can override any part.
   *
   * Return `void` to accept all defaults.
   *
   * @example Switch model for continuations
   * ```typescript
   * beforeTurn(ctx: TurnContext) {
   *   if (ctx.continuation) return { model: this.cheapModel };
   * }
   * ```
   *
   * @example Restrict active tools
   * ```typescript
   * beforeTurn(ctx: TurnContext) {
   *   return { activeTools: ["read", "write"] };
   * }
   * ```
   */
  beforeTurn(
    _ctx: TurnContext
  ): TurnConfig | void | Promise<TurnConfig | void> {}

  /**
   * Authorize action permissions for the current turn. Returning `true` grants
   * all action permissions. Returning `grantedPermissions` limits the default
   * `authorizeAction` implementation to that permission set.
   */
  authorizeTurn(
    _ctx: TurnContext
  ): ActionAuthorizationDecision | Promise<ActionAuthorizationDecision> {
    return true;
  }

  /**
   * Authorize a single action call after its model input and required
   * permissions are known. Override this for app-specific policy; the default
   * implementation enforces the grant returned from `authorizeTurn`.
   */
  authorizeAction(
    ctx: ActionAuthorizationContext
  ): ActionAuthorizationDecision | Promise<ActionAuthorizationDecision> {
    const turnAuthorization = this._activeTurnAuthorization;
    if (!turnAuthorization.allowed) {
      return {
        allowed: false,
        reason: turnAuthorization.reason
      };
    }
    if (turnAuthorization.grantedPermissions === undefined) {
      return true;
    }
    const granted = new Set(turnAuthorization.grantedPermissions);
    const missing = ctx.requiredPermissions.filter(
      (permission) => !granted.has(permission)
    );
    if (missing.length === 0) return true;
    return {
      allowed: false,
      reason: `Missing required permission: ${missing.join(", ")}`
    };
  }

  /**
   * Enrich the approval descriptor shown in approval UIs for a paused codemode
   * `execute` execution. The default descriptor is derived from the first
   * pending action as `connector.method` with its args as the input; override
   * here to supply a human summary, the permissions it consumes, or a risk
   * level (returned fields are merged over the derived defaults).
   *
   * Not called for `kind: "durable-pause"` actions — those carry their own
   * descriptor from the `action()` config. Default returns `undefined` (use the
   * derived descriptor).
   */
  describePausedExecution(
    _pending: import("@cloudflare/codemode").PendingAction[],
    _ctx: { requestId: string; toolCallId: string }
  ): Partial<ActionApprovalDescriptor> | undefined {
    return undefined;
  }

  /**
   * Called before each AI SDK step in the agentic loop. Backed by
   * `streamText({ prepareStep })`.
   *
   * Return `void` to accept the current step defaults, or return a
   * `StepConfig` to override the model, tool choice, active tools,
   * system prompt, messages, experimental context, or provider options
   * for this step. Use `beforeTurn` for turn-wide assembly and
   * `beforeStep` when the decision depends on the step number or
   * previous step results.
   *
   * @example Force search on the first step
   * ```typescript
   * beforeStep(ctx: PrepareStepContext) {
   *   if (ctx.stepNumber === 0) {
   *     return {
   *       activeTools: ["search"],
   *       toolChoice: { type: "tool", toolName: "search" }
   *     };
   *   }
   * }
   * ```
   *
   * @example Switch to a cheaper model after tool results land
   * ```typescript
   * beforeStep(ctx: PrepareStepContext) {
   *   // assumes a `fastSummaryModel` field on your Think subclass
   *   if (ctx.steps.some((s) => s.toolResults.length > 0)) {
   *     return { model: this.fastSummaryModel };
   *   }
   * }
   * ```
   */
  beforeStep(
    _ctx: PrepareStepContext
  ): StepConfig | void | Promise<StepConfig | void> {}

  /**
   * Called **before** the tool's `execute` function runs. Think wraps
   * every tool's `execute` so it can consult this hook and act on the
   * returned `ToolCallDecision`:
   *
   * - `void` (or `{ action: "allow" }` with no `input`) — run the
   *   original `execute` with the original input.
   * - `{ action: "allow", input }` — run the original `execute` with
   *   the substituted input.
   * - `{ action: "block", reason }` — skip `execute`; the model sees
   *   `reason` as the tool's output.
   * - `{ action: "substitute", output }` — skip `execute`; the model
   *   sees `output` as the tool's output.
   *
   * Only fires for server-side tools (tools with `execute`). Client
   * tools are handled on the client — Think can't intercept them.
   *
   * `afterToolCall` always fires after this hook (or after the original
   * `execute` when `allow`). For `block`/`substitute`, the substituted
   * value flows through `afterToolCall` as `success: true, output: ...`.
   *
   * @example Log tool calls
   * ```typescript
   * beforeToolCall(ctx: ToolCallContext) {
   *   console.log(`Tool called: ${ctx.toolName}`, ctx.input);
   * }
   * ```
   *
   * @example Block a tool the model shouldn't be calling here
   * ```typescript
   * beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
   *   if (ctx.toolName === "delete" && this.isReadOnlyMode) {
   *     return { action: "block", reason: "delete is disabled in read-only mode" };
   *   }
   * }
   * ```
   *
   * @example Substitute a cached result
   * ```typescript
   * async beforeToolCall(ctx: ToolCallContext): Promise<ToolCallDecision | void> {
   *   if (ctx.toolName === "weather") {
   *     const cached = await this.cache.get(JSON.stringify(ctx.input));
   *     if (cached) return { action: "substitute", output: cached };
   *   }
   * }
   * ```
   */
  beforeToolCall(
    _ctx: ToolCallContext
  ): ToolCallDecision | void | Promise<ToolCallDecision | void> {}

  /**
   * Called **after** a tool's outcome is known — for real executions, for
   * `block` (carries the `reason` as `output`), and for `substitute`
   * (carries the substituted `output`). Backed by the AI SDK's
   * `experimental_onToolCallFinish`, so `durationMs` and the discriminated
   * `success`/`output`/`error` outcome reflect what the model actually
   * sees: a thrown error from the original `execute` becomes
   * `success: false, error: ...`; everything else (including blocked /
   * substituted calls) is `success: true, output: ...`.
   *
   * Override for logging, metrics, or result inspection.
   *
   * @example
   * ```typescript
   * afterToolCall(ctx: ToolCallResultContext) {
   *   if (ctx.success) {
   *     console.log(`${ctx.toolName} ok in ${ctx.durationMs}ms`);
   *   } else {
   *     console.error(`${ctx.toolName} failed:`, ctx.error);
   *   }
   * }
   * ```
   */
  afterToolCall(_ctx: ToolCallResultContext): void | Promise<void> {}

  /**
   * Called after each step completes (initial, continue, tool-result).
   * Override for step-level logging or analytics.
   */
  onStepEnd(ctx: StepContext): void | Promise<void> {
    return this.onStepFinish(ctx);
  }

  /**
   * Called after each step completes (initial, continue, tool-result).
   * Override for step-level logging or analytics.
   * @deprecated Prefer `onStepEnd`.
   */
  onStepFinish(_ctx: StepContext): void | Promise<void> {}

  /**
   * Called for each streaming chunk. High-frequency — fires per token.
   * Override for streaming analytics, progress indicators, or token counting.
   * Observational only (void return).
   */
  onChunk(_ctx: ChunkContext): void | Promise<void> {}

  /**
   * Called after a chat turn completes and the assistant message has been
   * persisted. The turn lock is released before this hook runs, so it is
   * safe to call other methods from inside.
   *
   * Fires for all turn completion paths: WebSocket chat requests,
   * sub-agent RPC, and auto-continuation.
   *
   * Override for logging, chaining, analytics, usage tracking.
   */
  onChatResponse(_result: ChatResponseResult): void | Promise<void> {}

  /**
   * Handle an error that occurred during a chat turn.
   * Override to customize error handling (e.g. logging, metrics).
   */
  onChatError(error: unknown, _ctx?: ChatErrorContext): unknown {
    return error;
  }

  /**
   * Classify a raw chat-turn error into a provider-agnostic category.
   *
   * Think deliberately ships **no** provider-specific matching: it cannot know
   * that Anthropic's `"prompt is too long"` or OpenAI's
   * `context_length_exceeded` means "context overflow" without baking provider
   * knowledge into core. The app does know its provider/model, so it owns the
   * mapping — the same split Think already uses for `tokenCounter`.
   *
   * Think consults it when a turn's stream errors. Return `"context_overflow"`
   * to run the compact-and-retry backstop (only when `contextOverflow.reactive`
   * is enabled); if recovery cannot save the turn, that classification is
   * surfaced on the terminal `onChatError` call via
   * {@link ChatErrorContext.classification}. Return `"transient"` or
   * `"rate_limit"` to route the turn into bounded chat recovery (the same path
   * as a stream stall: `onChatRecovery`, `chatRecovery.maxAttempts`, then the
   * exhaustion message), with the continuation delayed by exponential backoff.
   * Returning `void`, `"fatal"`, or `"unknown"` keeps the existing terminal
   * behavior.
   *
   * The argument may be an `Error`, an AI SDK `APICallError` (with
   * `statusCode`/`responseBody`), or — for in-stream provider errors that
   * surface as a stream error part rather than a throw — the error message
   * string. Narrow accordingly.
   *
   * The second argument carries a {@link ChatErrorContext}: when consulted for
   * overflow recovery it is `{ stage: "stream", requestId }`, so a classifier
   * can correlate the error with the in-flight turn (e.g. to call
   * {@link cancelChat}).
   *
   * @example Anthropic + OpenAI context-overflow
   * ```typescript
   * classifyChatError(error: unknown): ChatErrorClassification | void {
   *   const text = error instanceof Error ? error.message : String(error);
   *   if (/prompt is too long|context length|context_length_exceeded|maximum context/i.test(text)) {
   *     return "context_overflow";
   *   }
   * }
   * ```
   */
  classifyChatError(
    _error: unknown,
    _ctx?: ChatErrorContext
  ): ChatErrorClassification | void {}

  /**
   * The provider `Retry-After` of an error the stream reported in-band. The
   * recovery engine reads a thrown error's headers itself. An in-band error
   * reaches it wrapped, with the provider's error object on `original`.
   */
  private _streamErrorRetryAfter(error: unknown): number | undefined {
    return error instanceof TransientChatStreamError
      ? retryAfterSeconds(error.original)
      : undefined;
  }

  private _compactForContextOverflow(
    reason: "reactive" | "proactive",
    extra?: { requestId?: string; attempt?: number }
  ): Promise<boolean> {
    return this.#overflow.compact(reason, extra);
  }

  private _finalizeContextOverflowError(
    requestId: string,
    rawError: string | undefined
  ): string {
    return this.#overflow.finalize(requestId, rawError);
  }

  // ── Extension initialization ───────────────────────────────────

  private async _initializeExtensions(): Promise<void> {
    this.extensionManager = createThinkExtensionManager({
      loader: this.extensionLoader!,
      storage: this.ctx.storage,
      agentClassName: this.constructor.name,
      agentId: this.ctx.id.toString(),
      exports: (this.ctx as unknown as { exports?: Record<string, unknown> })
        .exports
    });
    await loadThinkExtensions(
      this.extensionManager,
      this.getExtensions(),
      this.context
    );
  }

  // ── Inference loop (Think owns this) ──────────────────────────

  /**
   * The repaired history the current turn's model request is built from: the
   * active path, cut at `_turnHistoryLeafId` when one is set. A leaf off the
   * cached path (another branch, or outside a windowed cache) is read from
   * storage. The cut comes before repair so messages past the leaf, which the
   * request never sees, are not rewritten.
   */
  private async _turnHistory(): Promise<BeforeTurnRepairResult> {
    const leafId = this._turnHistoryLeafId;
    if (leafId === undefined) {
      return this._repairAndPersistTranscript(this.messages);
    }
    const cut = this.messages.findIndex((message) => message.id === leafId);
    if (cut >= 0) {
      return this._repairAndPersistTranscript(this.messages.slice(0, cut + 1));
    }
    const budget = this.hydrationByteBudget;
    const path = (
      Number.isFinite(budget) && budget > 0
        ? (await this.session.getRecentHistory(budget, { leafId })).messages
        : await this.session.getHistory({ leafId })
    ) as UIMessage[];
    return this._repairAndPersistTranscript(path);
  }

  /**
   * Assemble provider-ready model messages from the current session history:
   * repair the transcript, truncate older messages, drop any still-incomplete
   * tool calls, and convert to `ModelMessage[]`. Shared by the turn entry point
   * and the proactive context guard so a mid-turn recompaction rebuilds the
   * head through the exact same pipeline.
   */
  private async _assembleModelMessages(
    tools: ToolSet
  ): Promise<ModelMessage[]> {
    return modelMessagesFromHistory(await this._turnHistory(), {
      tools,
      truncationStep: this.truncationStep,
      incompleteToolCallIds: (messages) => unsettledToolCallIds(messages),
      onIncompleteToolCalls: (toolCallIds) =>
        this._emit("chat:transcript:repaired", {
          removedToolCalls: toolCallIds.length,
          normalizedInputs: 0,
          toolCallIds
        })
    });
  }

  /** Drain an abandoned inference stream so its trace span ends. */
  private _drainInferenceStream(result: object): void {
    drainInferenceStream(result, (promise) => this.ctx.waitUntil(promise));
  }

  /** Who a turn's AI SDK telemetry names: this agent and its admitted turn. */
  private _telemetryIdentity(): TelemetryIdentity {
    const turn = admittedTurnContext.getStore();
    return {
      className: this.constructor.name,
      agentId: this.name,
      conversationId: this.ctx.id.toString(),
      ...(turn?.agent === this && { turn })
    };
  }

  /**
   * The single convergence point for all chat turn entry paths.
   * Merges tools, assembles context, fires lifecycle hooks, wraps tools
   * for interception, and calls streamText. `historyLeafId` cuts the model
   * history at that message (see `_turnHistoryLeafId`).
   */
  private async _runInferenceLoop(
    input: TurnInput,
    historyLeafId?: string
  ): Promise<StreamableResult> {
    const turn = admittedTurnContext.getStore();
    const active = this._activeAdmittedTurn();
    const invoke = await this._withAgentSpan(
      "prepare_agent",
      "turn",
      {
        "cloudflare.agents.component": "think",
        ...(turn?.agent === this
          ? {
              "cloudflare.agents.turn.request_id": turn.requestId,
              "cloudflare.agents.turn.trigger": turn.trigger,
              "cloudflare.agents.turn.admission": turn.admission,
              "cloudflare.agents.turn.channel": turn.channel,
              "cloudflare.agents.turn.continuation": turn.continuation,
              "cloudflare.agents.turn.generation": turn.generation
            }
          : {})
      },
      () => this._prepareInferenceInvocation(input, historyLeafId)
    );
    const result = invoke();
    // Recorded once the stream starts, not at admission: a turn skipped by a
    // reset or a cancelled submission, or one whose preparation threw, never
    // ran, so a continuation must not extend it.
    if (active) this._lastTurnChannel = { channel: active.channel };
    return result;
  }

  private async _prepareInferenceInvocation(
    input: TurnInput,
    historyLeafId: string | undefined
  ): Promise<() => StreamableResult> {
    this._turnHistoryLeafId = historyLeafId;
    await this._flushDeferredResolvedPauses();
    // Keep one exposure policy for this inference attempt even if subclass
    // code changes the instance property while asynchronous setup is running.
    const includeMcpTools = this.includeMcpTools;
    // Reset the per-turn watchdog override; `beforeTurn` may set it below. A
    // turn that doesn't override falls back to the instance-level value.
    this._activeStallTimeoutMs = undefined;
    this._activeTurnAuthorization = { allowed: true };
    this._activeTurnApprovedActionInputs = approvedActionInputs(this.messages);
    this._turnIsContinuation = input.continuation;
    if (this.waitForMcpConnections) {
      const timeout =
        typeof this.waitForMcpConnections === "object"
          ? this.waitForMcpConnections.timeout
          : 10_000;
      await this.mcp.waitForConnections({ timeout });
    }

    // Computer's tools: exec offers every backend the Workspace has.
    const workspaceTools: ToolSet = createAITools({
      workspace: this.workspace
    });
    const fetchToolSet: ToolSet = this.fetchTools
      ? createFetchTools({
          ...this.fetchTools,
          workspace: this.workspace,
          onEvent: (event: FetchToolEvent) => {
            (
              this._emit as unknown as (
                type: string,
                payload: Record<string, unknown>
              ) => void
            ).call(this, "tool:fetch", { ...event });
          }
        })
      : {};
    const baseTools = this.getTools();
    const actionTools = await this._compileActionTools();
    const extensionTools = this.extensionManager?.getTools() ?? {};
    await this.#skills.refresh();
    const contextTools = await this.context.tools();
    const skillTools = this.#skills.tools(() => this.getSkillScriptRunner());
    const clientToolSet = createToolsFromClientSchemas(
      input.clientTools,
      input.clientToolExecutor
        ? { execute: input.clientToolExecutor }
        : undefined
    );
    let tools: ToolSet = {
      ...workspaceTools,
      ...fetchToolSet,
      ...baseTools,
      ...actionTools,
      ...extensionTools,
      ...contextTools,
      ...skillTools,
      ...(includeMcpTools ? (this.mcp?.getAITools?.() ?? {}) : {}),
      ...clientToolSet
    };

    // Per-channel policy (overridable defaults applied BEFORE `beforeTurn`):
    // narrow the tool set (the `config.tools` seam can only ADD, never remove)
    // and prepend channel instructions to the base system prompt.
    const channelContext = this._activeChannelContext;
    const channelDefinition = channelContext
      ? this._channels?.get(channelContext.channelId)
      : undefined;
    if (channelDefinition?.tools) {
      tools = channelDefinition.tools(tools);
    }

    const channelInstructions =
      channelDefinition?.instructions && channelContext
        ? typeof channelDefinition.instructions === "function"
          ? await channelDefinition.instructions(channelContext)
          : channelDefinition.instructions
        : undefined;

    const rawBaseSystem = await this._buildBaseSystemPrompt();
    const baseSystem = channelInstructions
      ? `${channelInstructions}\n\n${rawBaseSystem}`
      : rawBaseSystem;
    const system = systemPromptForTurn(baseSystem, tools);

    this._turnContextReminder = await this.context.reminder();
    const messages = withContextReminder(
      await this._assembleModelMessages(tools),
      this._turnContextReminder
    );

    if (messages.length === 0) {
      throw new Error(
        "No messages to send to the model. This usually means the chat request " +
          "arrived before any messages were persisted."
      );
    }

    // The default model is resolved on first read, so a `beforeTurn` that
    // returns its own `model` without reading `ctx.model` never calls
    // `getGateway` or needs the AI binding for the default.
    let defaultModel: LanguageModel | undefined;
    const resolveDefaultModel = () => (defaultModel ??= this.resolveModel());
    const turn = this.activeTurn;
    const messenger = this._activeMessengerContext();
    const ctx: TurnContext = {
      system,
      messages,
      tools,
      get model() {
        return resolveDefaultModel();
      },
      continuation: input.continuation,
      body: input.body,
      ...(turn && { requestId: turn.requestId, trigger: turn.trigger }),
      ...(input.signal && { abortSignal: input.signal }),
      ...(messenger && { messenger })
    };

    const subclassConfig = (await this.beforeTurn(ctx)) ?? {};
    const config = await this.#extensionHooks.beforeTurn(ctx, subclassConfig);

    const finalModel =
      config.model != null
        ? this.resolveModel(config.model)
        : resolveDefaultModel();
    const finalSystem =
      config.instructions ??
      config.system ??
      systemPromptForTurn(
        baseSystem,
        config.tools ? { ...tools, ...config.tools } : tools
      );
    const finalMessages = ensureValidContinueCheckpoint(
      config.messages ?? messages
    );
    const mergedTools: ToolSet = config.tools
      ? { ...tools, ...config.tools }
      : tools;
    const finalTurnContext: TurnContext = {
      ...turnContextWithoutModel(ctx),
      system: finalSystem,
      messages: finalMessages,
      tools: mergedTools,
      model: finalModel
    };
    this._activeTurnAuthorization = normalizeActionAuthorization(
      await this.authorizeTurn(finalTurnContext)
    );
    // Wrap each tool's `execute` so `beforeToolCall` is consulted before
    // the tool actually runs. The wrapped `execute` honors the returned
    // `ToolCallDecision` — `block` short-circuits with `reason`,
    // `substitute` returns `output` directly, `allow` runs the original
    // (optionally with modified `input`).
    const finalTools: ToolSet = wrapToolsWithDecision(mergedTools, {
      beforeToolCall: (ctx) => this.beforeToolCall(ctx),
      observeStart: (event) => this.#extensionHooks.toolCallStart(event),
      requestId: () => this.activeTurn?.requestId,
      rejectChangedApprovedInput: (toolCallId, input) => {
        const approved = this._activeTurnApprovedActionInputs.get(toolCallId);
        return approved !== undefined && !stableJsonEqual(input, approved)
          ? actionApprovalInputErrorEnvelope()
          : undefined;
      }
    });

    // Baseline for the proactive context guard: everything the AI SDK appends
    // to the model-message list after the assembled turn messages belongs to
    // this turn's steps, so a mid-turn recompaction can keep that tail and only
    // re-summarize the (now-compacted) head. Captured from the FINAL messages
    // and tools — after `beforeTurn` may have overridden them — so the tail
    // splice stays correct even when the override changes the message count.
    this.#overflow.beginRun(finalMessages.length);
    this._activeTurnTools = mergedTools;
    this._recordUnexecutedTools(mergedTools);

    // Resolve the per-turn stall-watchdog override (explicit `0` = off for this
    // turn). Read by `_streamResult` / `_streamResultToRpcCallback` when arming
    // the watchdog. `??` so a `0` override is honored, not treated as "unset".
    this._activeStallTimeoutMs =
      config.chatStreamStallTimeoutMs ?? this.chatStreamStallTimeoutMs;

    return createInferenceInvocation({
      config,
      model: finalModel,
      system: finalSystem,
      messages: finalMessages,
      tools: finalTools,
      // `maxTurns` is an overridable per-channel default: a user `beforeTurn`
      // returning `maxSteps` still wins, then the channel cap, then the
      // instance default.
      maxSteps: config.maxSteps ?? channelDefinition?.maxTurns ?? this.maxSteps,
      sendReasoning: config.sendReasoning ?? this.sendReasoning,
      continuation: input.continuation ?? false,
      messageMetadata: config.messageMetadata ?? this.messageMetadata,
      workflowPrompt: input.workflowPrompt,
      signal: input.signal,
      telemetry: this._telemetryIdentity(),
      invocationBounded: admittedTurnContext.getStore()?.trigger === "ws-chat",
      storeMessages: this.storeMessages,
      storeTools: this.storeTools,
      hooks: {
        compactBeforeStep: (event) => this.#overflow.compactBeforeStep(event),
        beforeStep: (event) => this.beforeStep(event),
        onChunk: async (event) => {
          await this.onChunk(event);
          await this.#extensionHooks.chunk(event);
        },
        onStepEnd: async (event) => {
          await this.onStepEnd(event);
          await this.#extensionHooks.stepFinish(event);
        },
        afterToolCall: async (ctx, event) => {
          await this.afterToolCall(ctx);
          await this.#extensionHooks.toolCallFinish(event);
        },
        requestId: () => this.activeTurn?.requestId,
        resolveModel: (model) => this.resolveModel(model),
        transformResult: (result) => this._transformInferenceResult(result)
      }
    });
  }

  /** @internal Test seam — override in test agents to wrap the stream (e.g. error injection). */
  protected _transformInferenceResult(
    result: StreamableResult
  ): StreamableResult {
    return result;
  }

  /** What the turn's compiled action tools call on this agent. */
  readonly #actionToolHost: ActionToolHost = {
    agent: this,
    env: () => this.env as Cloudflare.Env,
    requestId: () => admittedTurnContext.getStore()?.requestId ?? "",
    isApproved: (toolCallId) =>
      this._activeTurnApprovedActionInputs.has(toolCallId),
    grantedPermissions: () => this._activeTurnAuthorization.grantedPermissions,
    authorizeAction: (ctx) => this.authorizeAction(ctx),
    recordApprovalDescriptor: (toolCallId, descriptor) =>
      this._activeTurnActionApprovalDescriptors.set(toolCallId, descriptor),
    recordReplyAttachment: (requestId, attachment, toolName) =>
      this._recordReplyAttachment(requestId, attachment, toolName),
    runLedgered: (args) => this._runLedgeredAction(args),
    parkDurablePause: (args) => this._parkDurablePauseAction(args)
  };

  private async _compileActionTools(): Promise<ToolSet> {
    const actions = await this.getActions();
    this._activeTurnActionMetadata = new Map();
    this._activeTurnActionApprovalDescriptors = new Map();
    return compileActionTools(
      actions,
      this.#actionToolHost,
      this._activeTurnActionMetadata
    );
  }

  private _emitActionLedgerEvent(event: ActionLedgerEvent): void {
    const emit = this._emit as unknown as (
      type: string,
      payload: Record<string, unknown>
    ) => void;
    emit.call(this, event.type, event.payload);
  }

  private _emitChannelEvent(event: ChannelEvent): void {
    const emit = this._emit as unknown as (
      type: string,
      payload: Record<string, unknown>
    ) => void;
    emit.call(this, event.type, event.payload);
  }

  /**
   * Run an action's `execute` through the action ledger: same-isolate
   * coalescing, durable claim/replay, settle-on-success, release-on-failure.
   * Shared by the inline server-action path and the durable-pause-on-approve
   * path so an action's side effect is replay-safe regardless of how it is
   * dispatched. `runAction` must already apply timeout/abort and
   * `prepareActionOutputForModel`.
   */
  private async _runLedgeredAction(args: {
    toolName: string;
    idempotencyKey: ActionIdempotencyKey<unknown> | undefined;
    input: unknown;
    ctx: ActionContext;
    runAction: () => Promise<unknown>;
  }): Promise<unknown> {
    const { toolName, idempotencyKey, input, ctx, runAction } = args;
    const key = await this._resolveActionLedgerKey(
      toolName,
      idempotencyKey,
      input,
      actionContextWithoutReply(ctx)
    );
    // A failed run takes back the reply attachments it recorded.
    const attachmentCount = this._activeTurnReplyAttachments.length;
    const run = async () => {
      try {
        return await runAction();
      } catch (error) {
        this._activeTurnReplyAttachments.length = attachmentCount;
        throw error;
      }
    };
    if (!key) return await run();

    let outcome: EffectOutcome<unknown>;
    try {
      outcome = await this._approvals.once({
        key,
        name: toolName,
        input,
        // An explicit `idempotencyKey` is the developer's assertion that
        // retrying the keyed side effect is safe, so only those claims may be
        // taken over when stale. Fallback `tool:${toolCallId}` keys never are.
        reclaimAfterMs:
          idempotencyKey !== undefined
            ? this.actionLedgerPendingRetryLeaseMs
            : false,
        context: { requestId: ctx.requestId, toolCallId: ctx.toolCallId },
        run
      });
    } catch (error) {
      return actionErrorEnvelope(error);
    }
    const event = { action: toolName, key, inputHash: stableHash(input) };
    switch (outcome.status) {
      case "replayed":
        this._emitActionLedgerEvent({
          type: "action:ledger:replayed",
          payload: event
        });
        return outcome.value;
      case "in-doubt":
        this._emitActionLedgerEvent({
          type: "action:ledger:pending",
          payload: event
        });
        return actionPendingErrorEnvelope();
      case "conflict":
        this._emitActionLedgerEvent({
          type: "action:ledger:conflict",
          payload: event
        });
        return actionKeyConflictEnvelope(toolName, key);
      case "unrecorded":
        this._emitActionLedgerEvent({
          type: "action:ledger:serialize_failed",
          payload: { action: toolName, key }
        });
        return outcome.value;
      case "reclaimed":
        this._emitActionLedgerEvent({
          type: "action:ledger:reclaimed",
          payload: { ...event, ageMs: outcome.ageMs }
        });
        break;
      case "ran":
        break;
    }
    this._emitActionLedgerEvent({
      type: "action:ledger:settled",
      payload: event
    });
    return outcome.value;
  }

  /**
   * Park a `kind: "durable-pause"` action for human approval. Persists a
   * compaction-safe pending row (action name + model input + approval
   * descriptor) so the approval survives history compaction, deploys, and
   * isolate eviction, then returns the minimal model-visible paused output.
   *
   * The action's `execute` does NOT run here — it runs later in
   * `approveExecution` via `_runLedgeredAction`, so the side effect is gated on
   * human approval AND remains replay-safe. The rich descriptor lives on the
   * row and on the transcript part, never embedded in the model-visible output.
   */
  private _parkDurablePauseAction(args: {
    toolName: string;
    input: unknown;
    ctx: ActionContext;
    summary: string;
    permissions: string[];
    risk?: "low" | "medium" | "high";
  }): {
    status: "paused";
    executionId: string;
    action: string;
    message: string;
  } {
    const { toolName, input, ctx, summary, permissions, risk } = args;
    const executionId = `${ACTION_PAUSE_ID_PREFIX}${crypto.randomUUID()}`;
    const descriptor: ActionApprovalDescriptor = {
      requestId: ctx.requestId,
      toolCallId: ctx.toolCallId,
      action: toolName,
      summary,
      input,
      permissions,
      ...(risk !== undefined && { risk }),
      kind: "durable-pause"
    };
    this._insertActionPendingRow({
      execution_id: executionId,
      action_name: toolName,
      tool_call_id: ctx.toolCallId,
      request_id: ctx.requestId || null,
      input_json: JSON.stringify(input),
      descriptor_json: JSON.stringify(descriptor),
      created_at: Date.now()
    });
    this._emitActionPauseEvent({
      type: "action:pause:created",
      payload: { action: toolName, executionId, toolCallId: ctx.toolCallId }
    });
    return {
      status: "paused",
      executionId,
      action: toolName,
      message:
        "This action is awaiting human approval. Stop and wait for the " +
        "approval result before proceeding."
    };
  }

  /** Default hook timeout in milliseconds. */
  hookTimeout = 5000;

  /** Runs the extension hooks of each turn. */
  readonly #extensionHooks = new ThinkExtensionHooks({
    manager: () => this.extensionManager,
    timeoutMs: () => this.hookTimeout
  });

  /**
   * Hand out an RPC stub to this agent's Workspace. `getWorkspace(stub)`
   * from `@cloudflare/computer` calls it to reach the Workspace from
   * another Worker or Durable Object, and the Worker shell backend calls it
   * so its isolate can reach back into the Workspace.
   *
   * Only a Workspace this agent owns can hand out a stub; a client for
   * another object's Workspace cannot.
   */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.__unsafe_ensureInitialized();
    const workspace = this.workspace;
    if (!isLocalWorkspace(workspace)) {
      throw new Error(
        "[Think] This agent's workspace belongs to another Durable Object, " +
          "so it cannot hand out a Workspace stub."
      );
    }
    await workspace.ready();
    return workspace.stub();
  }

  // ── Host bridge methods (called by HostBridgeLoopback via DO RPC) ──

  /** What a sandboxed extension can reach on this agent. */
  readonly #hostApi = createThinkHostApi({
    workspace: () => this.workspace,
    context: () => this.context,
    messages: () => this.messages,
    // Not saveMessages: that queues a turn, and a tool calling this during a
    // turn would wait on its own turn.
    appendMessage: (message) => this._appendMessageToHistory(message)
  });

  /**
   * Run one host operation for a sandboxed extension. `HostBridgeLoopback`
   * calls this after it checks the extension's permissions.
   *
   * @internal
   */
  async _cfHostBridge<K extends ThinkHostOperation>(
    operation: K,
    args: Parameters<ThinkHostApi[K]>
  ): Promise<Awaited<ReturnType<ThinkHostApi[K]>>> {
    await this.__unsafe_ensureInitialized();
    return await callThinkHostApi(this.#hostApi, operation, args);
  }

  private async _admitTurn<T>(
    spec: QueueTurnSpec<T>
  ): Promise<AdmittedQueueResult<T>>;
  private async _admitTurn<T>(spec: NonQueueTurnSpec<T>): Promise<T>;
  private async _admitTurn<T>(
    spec: TurnSpec<T>
  ): Promise<AdmittedQueueResult<T> | T> {
    if (spec.admission !== "queue") {
      // The non-queue (submit/execute-submission) path runs `execute()` here
      // directly — it does NOT pass through `_runInsideAdmittedTurnBody`, so the
      // channel context must be set here too.
      return this._withAgentSpan(
        "chat_submission",
        "submission",
        {
          "cloudflare.agents.component": "think",
          "cloudflare.agents.turn.trigger": spec.trigger,
          "cloudflare.agents.turn.admission": spec.admission,
          "cloudflare.agents.turn.channel": spec.channel
        },
        () =>
          this._withAgentSpan(
            spec.admission === "submit"
              ? "accept_chat_submission"
              : "execute_chat_submission",
            "submission",
            {
              "cloudflare.agents.component": "think",
              "cloudflare.agents.turn.trigger": spec.trigger,
              "cloudflare.agents.turn.admission": spec.admission,
              "cloudflare.agents.turn.channel": spec.channel
            },
            () => this._withChannelContext(spec.channel, () => spec.execute())
          )
      );
    }

    if (!spec.allowNested) {
      this._assertNotInsideAdmittedTurn(spec.trigger);
    }

    return this.keepAliveWhile(async () => {
      const turnPromise = this._turnQueue.enqueue(
        spec.requestId,
        () => this._runInsideAdmittedTurnBody(spec),
        spec.generation === undefined
          ? undefined
          : { generation: spec.generation }
      );
      spec.onQueued?.();
      return turnPromise;
    });
  }

  private _assertNotInsideAdmittedTurn(trigger: TurnTrigger): void {
    if (admittedTurnContext.getStore()?.agent !== this) return;
    throw new Error(
      `Think turn admission (${trigger}) cannot be called from inside an active turn; use runTurn({ mode: "submit" }) or addMessages() instead, and do not waitForSubmission() on it from inside the turn`
    );
  }

  private async _runInsideAdmittedTurnBody<T>(
    admitted: QueueTurnSpec<T>
  ): Promise<T> {
    const spec = admitted.inheritChannel
      ? { ...admitted, channel: this._channelForAutoContinuation() }
      : admitted;
    // A turn is one unit of traced work and owns its own boundary, never that
    // of whatever admitted it. A handler that awaits its turn ends at the same
    // moment anyway; one that does not — an ack-and-return submit, or an
    // auto-continuation fired from a timer — would otherwise close every span
    // in a turn that is still running, or hand it a context already dead.
    return withInvocationScope(
      () =>
        this._withAgentSpan(
          "chat_turn",
          "turn",
          {
            "cloudflare.agents.component": "think",
            "cloudflare.agents.turn.request_id": spec.requestId,
            "cloudflare.agents.turn.trigger": spec.trigger,
            "cloudflare.agents.turn.admission": spec.admission,
            "cloudflare.agents.turn.channel": spec.channel,
            "cloudflare.agents.turn.continuation": spec.continuation,
            "cloudflare.agents.turn.generation": spec.generation
          },
          (update) =>
            admittedTurnContext.run(
              {
                agent: this,
                requestId: spec.requestId,
                trigger: spec.trigger,
                admission: spec.admission,
                channel: spec.channel,
                continuation: spec.continuation,
                generation: spec.generation
              },
              async () => {
                const startedAt = Date.now();
                this._emit("chat:turn:start", {
                  requestId: spec.requestId,
                  trigger: spec.trigger,
                  admission: spec.admission,
                  ...(spec.continuation !== undefined && {
                    continuation: spec.continuation
                  }),
                  ...(spec.generation !== undefined && {
                    generation: spec.generation
                  })
                });

                this._activeTurnReplyAttachments = [];
                this._activeTurnReplyAttachmentsRequestId = spec.requestId;
                this._turnIsContinuation = false;

                try {
                  const value = await this._withChannelContext(
                    spec.channel,
                    () => spec.execute()
                  );
                  const status = spec.getStatus?.() ?? "completed";
                  this._emit("chat:turn:finish", {
                    requestId: spec.requestId,
                    trigger: spec.trigger,
                    admission: spec.admission,
                    ...(spec.continuation !== undefined && {
                      continuation: spec.continuation
                    }),
                    ...(spec.generation !== undefined && {
                      generation: spec.generation
                    }),
                    status,
                    durationMs: Date.now() - startedAt
                  });
                  update({ "cloudflare.agents.turn.status": status });
                  return value;
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  this._emit("chat:turn:finish", {
                    requestId: spec.requestId,
                    trigger: spec.trigger,
                    admission: spec.admission,
                    ...(spec.continuation !== undefined && {
                      continuation: spec.continuation
                    }),
                    ...(spec.generation !== undefined && {
                      generation: spec.generation
                    }),
                    status: "error",
                    durationMs: Date.now() - startedAt,
                    error: message
                  });
                  update({ "cloudflare.agents.turn.status": "error" });
                  throw error;
                } finally {
                  this._turnIsContinuation = false;
                }
              }
            )
        ),
      { detached: true }
    );
  }

  // ── Sub-agent RPC entry point ───────────────────────────────────

  /**
   * Run a chat turn: persist the user message, run the agentic loop,
   * stream UIMessageChunk events via callback, and persist the
   * assistant's response.
   *
   * @param userMessage The user's message(s), or a callback that derives them
   * from the in-queue transcript.
   * @param callback Streaming callback (typically an RpcTarget from the parent)
   * @param options Optional chat options (e.g. AbortSignal)
   */
  async chat(
    userMessage: TurnInputMessages,
    callback: StreamCallback,
    options?: ChatOptions
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const ignoredTools = (options as { tools?: unknown } | undefined)?.tools;
    if (
      ignoredTools != null &&
      typeof ignoredTools === "object" &&
      Object.keys(ignoredTools).length > 0
    ) {
      console.warn(
        "[Think] chat() no longer accepts options.tools. Define durable tools on the child agent with getTools(), or use runAgentTool()/agentTool() for parent-child orchestration."
      );
    }

    // Client tools supplied by the caller (e.g. a parent agent delegating to
    // this sub-agent). Both the schemas and the `onClientToolCall` executor are
    // forwarded per-turn only — deliberately NOT persisted into
    // `_lastClientTools`. The executor is a live RPC ref that dies with the
    // isolate, so unlike the WebSocket path there is no SPA that could ever
    // replay a `tool-result` after an eviction. Persisting the names would put
    // them in `_requestContext.clientToolNames()`, causing recovery to misclassify a
    // dangling `input-available` orphan as a pending human interaction and park
    // forever. Keeping them per-turn lets such an orphan recover like a server
    // tool: `continueLastTurn`'s transcript repair errors it and the model
    // proceeds. `_runInferenceLoop` sources client tools from `input.clientTools`
    // (not `_lastClientTools`), so the live turn is unaffected.
    const clientTools = options?.clientTools?.length
      ? options.clientTools
      : undefined;
    const clientToolExecutor = options?.onClientToolCall;

    // Whether the callback already got its terminal call, so a reset that
    // lands after the turn's answer does not report a second one.
    let terminalSent = false;
    const sink: StreamCallback = {
      onStart: (event) => callback.onStart(event),
      onEvent: (json) => callback.onEvent(json),
      onDone: () => {
        terminalSent = true;
        return callback.onDone();
      },
      onError: (error) => {
        terminalSent = true;
        return callback.onError(error);
      },
      onInterrupted: (info) => {
        terminalSent = true;
        return callback.onInterrupted?.(info);
      }
    };

    // The controller exists before the caller learns the request id, so a
    // `cancelChat(requestId)` sent from `onStart` finds it. The generation
    // is read here for the same reason: a clear during `onStart` must not
    // let the turn run in the cleared chat.
    const generation = this._turnQueue.generation;
    const cleared = () => this._turnQueue.generation !== generation;
    // Whether the caller cancelled the request itself. A clear aborts the
    // same signal, after it moved the generation on, so the generation at
    // the moment of the abort tells the two apart.
    let cancelledByCaller = false;
    const noteCancel = () => {
      if (!cleared()) cancelledByCaller = true;
    };
    // By id (`cancelChat`), which aborts the registry's controller...
    this._aborts
      .getSignal(requestId)
      ?.addEventListener("abort", noteCancel, { once: true });
    // ...or through the caller's own signal, which the turn core links only
    // once the turn is admitted, after `onStart`.
    if (options?.signal?.aborted) noteCancel();
    options?.signal?.addEventListener("abort", noteCancel, { once: true });
    // The chat was cleared under the request. The caller did not cancel it,
    // so a silent resolve would read as an answer. A caller that had already
    // cancelled is told nothing more.
    const reportCleared = async () => {
      if (terminalSent || cancelledByCaller) return;
      terminalSent = true;
      await callback.onError(CHAT_CLEARED_ERROR);
    };

    try {
      await callback.onStart({ requestId });
      if (cleared()) {
        await reportCleared();
        return;
      }
      // The turn core runs the turn: a request cancelled while it waited, or
      // while its message was worked out, stores nothing and never calls
      // the model, and a turn the chat was cleared under ends `skipped`.
      const result = await this._runServerTurn(requestId, {
        signal: options?.signal,
        spec: {
          trigger: "rpc",
          continuation: false,
          channel: options?.channel
        },
        prepare: async () => ({
          input:
            typeof userMessage === "function"
              ? await userMessage(this.messages)
              : this._normalizeChatMessages(userMessage)
        }),
        persist: async (resolved) => {
          for (const msg of stampTurnContext(
            resolved,
            options?.channel,
            options?.metadata
          )) {
            await this._appendMessageToHistory(msg);
          }
          this._broadcastMessages();
        },
        // The caller's tools are this turn's only, and it has no body.
        pinned: { clientTools: clientTools ?? null, body: null },
        model: { continuation: false, sink, clientToolExecutor }
      });
      if (result.status === "skipped") await reportCleared();
    } finally {
      // The core drops the controller. This covers an `onStart` that threw.
      this._aborts.remove(requestId);
      options?.signal?.removeEventListener("abort", noteCancel);
    }
  }

  /**
   * Unified turn admission API (Turns RFC, step 2).
   *
   * Thin facade over {@link Think.saveMessages}, {@link Think.continueLastTurn},
   * {@link Think.submitMessages}, and {@link Think.chat}. Each `mode` delegates
   * to the matching backing method with a narrowed option surface; the full
   * unified superset lands with `_admitTurn` (step 3).
   *
   * - `mode: "wait"` (default) — blocking turn; returns {@link TurnResult}.
   * - `mode: "submit"` — durable queued turn; returns {@link SubmitMessagesResult}.
   * - `mode: "stream"` — RPC-style streaming; returns `Promise<void>`.
   *
   * **Re-entrancy.** Calling `mode: "wait"` or `continuation: true` from inside
   * an active turn (a tool `execute`, a lifecycle hook) deadlocks on the turn
   * queue — identical to calling {@link Think.saveMessages} or
   * {@link Think.continueLastTurn} from there. Prefer `mode: "submit"` or
   * {@link Think.addMessages} instead. A submitted turn runs only after the
   * current turn ends, so {@link Think.waitForSubmission} on it from inside
   * the turn throws rather than deadlocking. Precise nested-call detection is
   * deferred to `_admitTurn` (step 3).
   *
   * **Empty input (`wait`).** String, single-message, and array inputs that
   * normalize to an empty list short-circuit to `{ status: "skipped" }` without
   * running inference. A function `input` that resolves to `[]` at run time is
   * not pre-checked (the function must see the in-queue transcript); step 3's
   * `_admitTurn` centralizes empty-skip inside the queue.
   *
   * @experimental
   */
  runTurn(options: RunTurnWait): Promise<TurnResult>;
  runTurn(options: RunTurnSubmit): Promise<SubmitMessagesResult>;
  runTurn(options: RunTurnStream): Promise<void>;
  async runTurn(
    options: RunTurnOptions
  ): Promise<TurnResult | SubmitMessagesResult | void> {
    const mode = this._resolveRunTurnMode(options);
    if (mode === "stream") {
      return this._runTurnStream(options as RunTurnStream);
    }
    if (mode === "submit") {
      return this._runTurnSubmit(options as RunTurnSubmit);
    }
    return this._runTurnWait(options as RunTurnWait);
  }

  private _resolveRunTurnMode(
    options: RunTurnOptions
  ): "wait" | "submit" | "stream" {
    if (options === null || typeof options !== "object") {
      throw new TypeError("runTurn: options must be an object");
    }

    const mode = (options as { mode?: unknown }).mode;
    if (mode === undefined || mode === "wait") return "wait";
    if (mode === "submit" || mode === "stream") return mode;
    throw new TypeError('runTurn: mode must be "wait", "submit", or "stream"');
  }

  private _validateRunTurnAdmission(
    options: RunTurnOptions,
    mode: "wait" | "submit" | "stream"
  ): void {
    const hasInput = options.input !== undefined;
    const continuation =
      mode === "wait" && (options as RunTurnWait).continuation === true;

    if (mode !== "wait" && (options as RunTurnWait).continuation === true) {
      throw new TypeError(
        'runTurn: continuation is only supported with mode: "wait"'
      );
    }

    if (mode === "stream" && !(options as RunTurnStream).callback) {
      throw new TypeError('runTurn: mode "stream" requires callback');
    }

    if (mode === "wait") {
      if (hasInput && continuation) {
        throw new TypeError(
          "runTurn: supply either input or continuation: true, not both"
        );
      }
      if (!hasInput && !continuation) {
        throw new TypeError(
          "runTurn: supply either input or continuation: true"
        );
      }
      return;
    }

    if (!hasInput) {
      throw new TypeError(`runTurn: mode "${mode}" requires input`);
    }
  }

  private _userMessageFromText(text: string): UIMessage {
    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }]
    };
  }

  private _normalizeRunTurnMessages(
    input: Exclude<
      TurnInputMessages,
      (current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>
    >
  ): UIMessage[] {
    if (typeof input === "string") {
      if (input.length === 0) return [];
      return [this._userMessageFromText(input)];
    }
    if (Array.isArray(input)) {
      return input;
    }
    return [input];
  }

  private _normalizeChatMessages(
    input: Exclude<
      TurnInputMessages,
      (current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>
    >
  ): UIMessage[] {
    if (typeof input === "string") {
      return [this._userMessageFromText(input)];
    }
    if (Array.isArray(input)) {
      return input;
    }
    return [input];
  }

  private _assertRunTurnSubmitInput(
    input: TurnInputMessages
  ): asserts input is string | UIMessage | UIMessage[] {
    if (typeof input === "function") {
      throw new Error(
        'runTurn({ mode: "submit" }) does not support function input until _admitTurn (step 3)'
      );
    }
  }

  private async _enrichTurnResult(
    result: ProgrammaticMessagesResult,
    continuation: boolean
  ): Promise<TurnResult> {
    const capture = waitTurnResultContext.getStore();
    const messageId =
      result.status === "completed" && capture?.agent === this
        ? capture.messageIds.get(result.requestId)
        : undefined;
    const message =
      messageId !== undefined ? await this.session.getMessage(messageId) : null;
    return {
      ...result,
      continuation,
      ...(message !== null && { message })
    };
  }

  private async _runTurnWait(options: RunTurnWait): Promise<TurnResult> {
    this._validateRunTurnAdmission(options, "wait");

    const capture = { agent: this, messageIds: new Map<string, string>() };
    return waitTurnResultContext.run(capture, async () => {
      if (options.continuation === true) {
        const continueOptions = {
          signal: options.signal,
          channel: options.channel
        };
        if (!isMethodOverridden(this, "continueLastTurn")) {
          const result = await this._continueLastTurn(options.body, {
            ...continueOptions,
            captureOutput: true
          });
          return this._enrichTurnResult(result, true);
        }
        const outputCapture: {
          agent: unknown;
          taken: boolean;
          result?: ProgrammaticMessagesResult;
        } = { agent: this, taken: false };
        const returned = await continuationOutputContext.run(
          outputCapture,
          () => this.continueLastTurn(options.body, continueOptions)
        );
        const captured = outputCapture.result;
        return this._enrichTurnResult(
          captured?.requestId === returned.requestId && "output" in captured
            ? { ...returned, output: captured.output }
            : returned,
          true
        );
      }

      const input = options.input;
      if (input === undefined) {
        throw new TypeError(
          "runTurn: supply either input or continuation: true"
        );
      }

      if (typeof input === "function") {
        const result = await this._runProgrammaticMessagesTurn(
          crypto.randomUUID(),
          input,
          {
            signal: options.signal,
            channel: options.channel,
            captureOutput: true
          }
        );
        return this._enrichTurnResult(result, false);
      }

      const messages = this._normalizeRunTurnMessages(input);
      if (messages.length === 0) {
        return { requestId: "", status: "skipped", continuation: false };
      }

      const result = await this._runProgrammaticMessagesTurn(
        crypto.randomUUID(),
        messages,
        {
          signal: options.signal,
          channel: options.channel,
          captureOutput: true
        }
      );
      return this._enrichTurnResult(result, false);
    });
  }

  private async _runTurnSubmit(
    options: RunTurnSubmit
  ): Promise<SubmitMessagesResult> {
    this._validateRunTurnAdmission(options, "submit");

    const input = options.input;
    if (input === undefined) {
      throw new TypeError('runTurn: mode "submit" requires input');
    }

    this._assertRunTurnSubmitInput(input);
    const messages = this._normalizeRunTurnMessages(input);
    return this.submitMessages(messages, {
      submissionId: options.submissionId,
      idempotencyKey: options.idempotencyKey,
      metadata: options.metadata,
      channel: options.channel
    });
  }

  private async _runTurnStream(options: RunTurnStream): Promise<void> {
    this._validateRunTurnAdmission(options, "stream");

    const input = options.input;
    if (input === undefined) {
      throw new TypeError('runTurn: mode "stream" requires input');
    }

    if (typeof input !== "function") {
      const messages = this._normalizeRunTurnMessages(input);
      if (messages.length === 0) {
        await options.callback.onStart({ requestId: crypto.randomUUID() });
        await options.callback.onDone();
        return;
      }
    }

    return this.chat(input, options.callback, {
      signal: options.signal,
      clientTools: options.clientTools,
      onClientToolCall: options.onClientToolCall,
      channel: options.channel
    });
  }

  // ── Message access ──────────────────────────────────────────────

  /** Get the conversation history as UIMessage[]. */
  async getMessages(): Promise<UIMessage[]> {
    return this.messages.slice();
  }

  /** Clear all messages from storage. */
  async clearMessages(): Promise<void> {
    this.resetTurnState();
    await this._clearHistory();
    this._broadcast({ type: MSG_CHAT_CLEAR });
  }

  protected formatAgentToolInput(input: unknown): UIMessage {
    const text =
      typeof input === "string" ? input : JSON.stringify(input, null, 2);
    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }]
    };
  }

  override async reportProgress<T = unknown>(
    progress: AgentToolProgress<T>,
    options?: { persist?: boolean }
  ): Promise<void> {
    const result = this._agentToolRuns.reportProgress(progress, options);
    if (result === "inactive") {
      console.warn(
        "[think] reportProgress() was called outside of an active agent-tool run; ignoring. Call it from within a turn that is running as a sub-agent."
      );
    }
  }

  protected getAgentToolOutput(_runId: string): unknown {
    return undefined;
  }

  protected getAgentToolSummary(runId: string, output: unknown): string {
    const text = this._getAgentToolFinalText(runId);
    if (text) return text;
    if (typeof output === "string") return output;
    if (output !== undefined) {
      try {
        return JSON.stringify(output);
      } catch {
        return String(output);
      }
    }
    return "";
  }

  /**
   * Format the message injected back into the chat when a `detached:
   * { notify: true }` run finishes. Override to customize the prose (or return
   * an empty string to suppress the notification for a given outcome). The
   * default announces the terminal status and any summary/error so the model
   * has enough context to react.
   */
  protected formatDetachedCompletion(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): string {
    const label = `Background task "${run.agentType}" (run ${run.runId})`;
    switch (result.status) {
      case "completed":
        return result.summary
          ? `${label} finished:\n\n${result.summary}`
          : `${label} finished successfully.`;
      case "error":
        return `${label} failed${result.error ? `: ${result.error}` : "."}`;
      case "aborted":
        return `${label} was cancelled.`;
      case "interrupted":
        return result.reason === "budget-exceeded"
          ? `${label} ran out of time before completing and was stopped.`
          : `${label} was interrupted before completing${result.error ? `: ${result.error}` : "."}`;
      default:
        return `${label} ended (${result.status}).`;
    }
  }

  /**
   * Serialize detached terminal delivery against the chat turn queue. A
   * fast-path push or backbone tick can land mid-turn, and an `onFinish` that
   * mutates state (`setState`, `submitMessages`, a follow-up `runAgentTool`)
   * running concurrently with an active LLM turn is a data race. Those paths
   * never run synchronously inside a turn body (they fire from `waitUntil` / a
   * scheduled alarm), so enqueuing on the turn queue runs the delivery strictly
   * between turns without risk of self-deadlock.
   *
   * An explicit `cancelAgentTool` (`serialize` unset) may be invoked from inside
   * the very turn that triggers it, where enqueuing WOULD self-deadlock, so it
   * runs inline in the caller's (or a fresh) `agentContext` instead. The Think
   * `notify` convenience is unaffected either way: it delivers via
   * `submitMessages`, which already serializes FIFO behind any active turn.
   */
  protected override async _runDetachedDelivery(
    invoke: () => Promise<void>,
    options?: { serialize?: boolean }
  ): Promise<void> {
    const inContext = () =>
      agentContext.run(
        {
          agent: this,
          connection: undefined,
          request: undefined,
          email: undefined
        },
        invoke
      );
    if (!options?.serialize) {
      if (agentContext.getStore()?.agent === this) {
        await invoke();
        return;
      }
      await inContext();
      return;
    }
    await this.keepAliveWhile(() =>
      this._turnQueue.enqueue(
        `detached-delivery:${crypto.randomUUID()}`,
        inContext
      )
    );
  }

  /**
   * Targeted completion hook for `detached: { notify: true }`. Auto-wired by
   * `runAgentTool` (resolved by name so the base Agent stays decoupled from the
   * chat layer). Injects the formatted completion as a programmatic turn so the
   * model reacts to the background result. Idempotent per run + status, so an
   * exactly-once finish — or a soft give-up followed by a real completion —
   * never injects a duplicate, while a give-up and a later real completion are
   * surfaced as two distinct turns.
   */
  async _cfDetachedNotifyFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    const text = this.formatDetachedCompletion(run, result);
    if (!text) return;
    await this.submitMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text }]
        }
      ],
      {
        idempotencyKey: `detached-finish:${run.runId}:${result.status}`,
        metadata: {
          source: run.notifySource ?? "detached-agent-tool",
          runId: run.runId,
          agentType: run.agentType,
          status: result.status
        }
      }
    );
  }

  /**
   * Format the synthetic message injected when a `detached: { onMilestones }`
   * milestone is reached. Override to customize the prose (or return an empty
   * string to suppress a given milestone). The default announces the milestone
   * name and any structured data so the model can react in-conversation before
   * the run finishes.
   */
  protected formatDetachedMilestone(
    run: AgentToolRunInfo,
    milestone: AgentToolMilestone
  ): string {
    const label = `Background task "${run.agentType}" (run ${run.runId})`;
    const detail =
      milestone.data !== undefined
        ? `\n\n${JSON.stringify(milestone.data, null, 2)}`
        : "";
    return `${label} reached milestone "${milestone.name}".${detail}`;
  }

  /**
   * Targeted milestone hook for `detached: { onMilestones }`. Idempotent per run
   * + milestone NAME (not sequence — a name surfaces at most once even if
   * re-emitted), so the warm tail and the backbone reconcile converge. Fired
   * from both paths.
   *
   * - `"narrate"` (default): a synthetic **assistant** message injected directly
   *   — no model turn — using a deterministic message id for idempotency
   *   (`addMessages` is a no-op for an id already in history).
   * - `"react"`: a **user-role** turn so the model responds to the milestone
   *   (idempotency via `submitMessages` + UNIQUE idempotency key).
   */
  protected override async _deliverDetachedMilestone(
    run: AgentToolRunInfo,
    milestone: AgentToolMilestone,
    mode: "react" | "narrate"
  ): Promise<void> {
    const text = this.formatDetachedMilestone(run, milestone);
    if (!text) return;
    const metadata = {
      source: run.notifySource ?? "detached-agent-tool",
      runId: run.runId,
      agentType: run.agentType,
      milestone: milestone.name
    };
    if (mode === "narrate") {
      await this.addMessages([
        {
          id: `detached-ms:${run.runId}:${milestone.name}`,
          role: "assistant",
          parts: [{ type: "text", text }],
          metadata
        }
      ]);
      return;
    }
    await this.submitMessages(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text }]
        }
      ],
      { idempotencyKey: `detached-ms:${run.runId}:${milestone.name}`, metadata }
    );
  }

  /**
   * Start this agent as an agent-tool run for a parent.
   *
   * @param options.signal - Aborting it cancels the run, the same as
   *   {@link cancelAgentToolRun}. An `AbortSignal` does not cross a Durable
   *   Object RPC call, so it works for a caller in the same isolate. A
   *   parent that reaches this agent over RPC cancels with
   *   `cancelAgentToolRun(runId, reason)`.
   */
  async startAgentToolRun(
    input: unknown,
    options: {
      runId: string;
      signal?: AbortSignal;
      eventDelivery?: AgentToolEventDelivery;
    }
  ): Promise<AgentToolRunInspection> {
    return this._agentToolRuns.start(
      options.runId,
      {
        input,
        terminalOnly: options.eventDelivery === "terminal",
        signal: options.signal
      },
      ({ requestId, signal, shouldStart }) =>
        this._runProgrammaticMessagesTurn(
          requestId,
          [this.formatAgentToolInput(input)],
          { signal, shouldApplyMessages: shouldStart, trigger: "agent-tool" }
        )
    );
  }

  async cancelAgentToolRun(runId: string, reason?: unknown): Promise<void> {
    this._agentToolRuns.cancel(runId, reason);
  }

  async inspectAgentToolRun(
    runId: string,
    options?: { reconcile?: boolean }
  ): Promise<AgentToolRunInspection | null> {
    return this._agentToolRuns.inspect(runId, options);
  }

  async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    return this._agentToolRuns.chunks(runId, options);
  }

  async tailAgentToolRun(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<AgentToolStoredChunk>> {
    // The stream carries newline-delimited JSON; the RPC boundary types it
    // as the chunks it encodes.
    return this._agentToolRuns.tail(runId, options, {
      chunks: (id, chunkOptions) => this.getAgentToolChunks(id, chunkOptions),
      inspect: (id) => this.inspectAgentToolRun(id)
    }) as unknown as ReadableStream<AgentToolStoredChunk>;
  }

  private _getAgentToolFinalText(runId: string): string | null {
    // The run's own replies. After an eviction the record of what was there
    // before is the newest message at the run's start (#1630).
    for (const msg of this._agentToolRuns.messagesSinceStart(
      runId,
      this.messages
    )) {
      if (msg.role !== "assistant") continue;
      const text = msg.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter((part) => part.length > 0)
        .join("\n");
      if (text.length > 0) return text;
    }
    return null;
  }

  // ── Action ledger ────────────────────────────────────────────────

  private async _resolveActionLedgerKey(
    actionName: string,
    spec: ActionIdempotencyKey<unknown> | undefined,
    input: unknown,
    ctx: ActionContext
  ): Promise<string | null> {
    if (spec !== undefined) {
      const key =
        typeof spec === "function" ? await spec({ input, ctx }) : spec;
      if (key.length === 0) {
        throw new Error(
          `Action "${actionName}" returned an empty idempotency key`
        );
      }
      return `action:${actionName}:${key}`;
    }
    return ctx.toolCallId ? `tool:${ctx.toolCallId}` : null;
  }

  /**
   * Delete expired ledger rows (at most once an hour unless `force`) and
   * report them as `action:ledger:swept`.
   */
  private async _sweepApprovals(options?: {
    force?: boolean;
  }): Promise<{ settled: number; pending: number }> {
    const swept = await this._approvals.sweep(options);
    const result = {
      settled: swept.settledEffects,
      pending: swept.pendingEffects
    };
    if (swept.effects > 0 || options?.force) {
      this._emitActionLedgerEvent({
        type: "action:ledger:swept",
        payload: result
      });
    }
    return result;
  }

  /**
   * Move action ledger rows an earlier version wrote in
   * `cf_think_action_ledger` into the Approvals effect ledger, then drop the
   * table. One way. Keys, input hashes and recorded values keep their form,
   * so a settled action still replays.
   */
  private async _migrateLegacyActionLedger(): Promise<void> {
    const [table] = this.sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'cf_think_action_ledger'
    `;
    if (!table) return;
    const rows = this.sql<{
      key: string;
      action_name: string;
      request_id: string | null;
      tool_call_id: string | null;
      input_hash: string;
      status: "pending" | "settled";
      result_json: string | null;
      created_at: number;
      updated_at: number;
    }>`
      SELECT key, action_name, request_id, tool_call_id, input_hash, status,
             result_json, created_at, updated_at
      FROM cf_think_action_ledger
    `;
    this._approvals.importRecords({
      effects: rows.map((row) => ({
        key: row.key,
        name: row.action_name,
        inputHash: row.input_hash,
        status: row.status,
        resultJson: row.result_json,
        context: {
          ...(row.request_id && { requestId: row.request_id }),
          ...(row.tool_call_id && { toolCallId: row.tool_call_id })
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });
    this.sql`DROP TABLE cf_think_action_ledger`;
    await this.ctx.storage.delete("cf_think_action_ledger:last_swept_at");
  }

  // ── Durable-pause action approvals ──────────────────────────────

  private _emitActionReplyEvent(event: ActionReplyEvent): void {
    const emit = this._emit as unknown as (
      type: string,
      payload: Record<string, unknown>
    ) => void;
    emit.call(this, event.type, event.payload);
  }

  /**
   * Record an advisory reply attachment for the active turn. Advisory: a
   * non-object, a missing/non-string `type`, or exceeding the per-turn cap is
   * silently ignored. The attachment is JSON-normalized to a safe copy so a
   * later mutation of the caller's object can't corrupt it and downstream
   * persistence/RPC can't choke on bigint/circular values.
   */
  private _recordReplyAttachment(
    requestId: string,
    attachment: unknown,
    actionName?: string
  ): void {
    if (!requestId || requestId !== this._activeTurnReplyAttachmentsRequestId) {
      return;
    }
    if (
      typeof attachment !== "object" ||
      attachment === null ||
      Array.isArray(attachment) ||
      typeof (attachment as { type?: unknown }).type !== "string"
    ) {
      return;
    }
    if (
      this._activeTurnReplyAttachments.length >= MAX_REPLY_ATTACHMENTS_PER_TURN
    ) {
      return;
    }
    const serialized = safeStringifyActionOutput(attachment);
    if (serialized.error || serialized.value === undefined) {
      return;
    }
    const normalized = JSON.parse(serialized.value) as unknown;
    if (
      typeof normalized !== "object" ||
      normalized === null ||
      Array.isArray(normalized) ||
      typeof (normalized as { type?: unknown }).type !== "string"
    ) {
      return;
    }
    this._activeTurnReplyAttachments.push(normalized as ReplyAttachment);
    this._emitActionReplyEvent({
      type: "action:reply-attached",
      payload: {
        ...(actionName !== undefined && { action: actionName }),
        attachmentType: (normalized as { type: string }).type
      }
    });
  }

  private _cloneReplyAttachment(attachment: ReplyAttachment): ReplyAttachment {
    return JSON.parse(JSON.stringify(attachment)) as ReplyAttachment;
  }

  /**
   * Advisory reply attachments recorded during a turn via `ctx.attachReply`.
   * Returns deep copies. With no `requestId`, returns the most recent turn's
   * attachments; with a `requestId`, returns them only if they belong to that
   * turn (else `[]`).
   */
  replyAttachments(requestId?: string): ReplyAttachment[] {
    if (
      requestId !== undefined &&
      requestId !== this._activeTurnReplyAttachmentsRequestId
    ) {
      return [];
    }
    return this._activeTurnReplyAttachments.map((attachment) =>
      this._cloneReplyAttachment(attachment)
    );
  }

  private _emitActionPauseEvent(event: ActionPauseEvent): void {
    const emit = this._emit as unknown as (
      type: string,
      payload: Record<string, unknown>
    ) => void;
    emit.call(this, event.type, event.payload);
  }

  private _ensureActionPendingTable(): void {
    if (this._actionPendingTableEnsured) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_think_action_pending_approvals (
        execution_id TEXT PRIMARY KEY,
        action_name TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        request_id TEXT,
        input_json TEXT NOT NULL,
        descriptor_json TEXT,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS cf_think_action_pending_created
      ON cf_think_action_pending_approvals (created_at)
    `;
    this._actionPendingTableEnsured = true;
  }

  private _readActionPendingRow(executionId: string): ActionPendingRow | null {
    this._ensureActionPendingTable();
    const rows = this.sql<ActionPendingRow>`
      SELECT execution_id, action_name, tool_call_id, request_id, input_json,
             descriptor_json, created_at
      FROM cf_think_action_pending_approvals
      WHERE execution_id = ${executionId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _insertActionPendingRow(row: ActionPendingRow): void {
    this._ensureActionPendingTable();
    this.sql`
      INSERT INTO cf_think_action_pending_approvals (
        execution_id, action_name, tool_call_id, request_id, input_json,
        descriptor_json, created_at
      )
      VALUES (
        ${row.execution_id}, ${row.action_name}, ${row.tool_call_id},
        ${row.request_id}, ${row.input_json}, ${row.descriptor_json},
        ${row.created_at}
      )
    `;
  }

  /**
   * Atomically claim a pending-approval row for resolution: read it, then
   * delete it. SQLite calls are synchronous and there is no `await` between the
   * read and the delete, so within the single DO isolate this is race-free — a
   * concurrent `approveExecution`/`rejectExecution` for the same id can only run
   * at an await boundary, by which point the row is already gone (it sees
   * `null` → "already resolved"). The returned row is the caller's to resolve.
   */
  private _claimActionPendingRow(executionId: string): ActionPendingRow | null {
    this._ensureActionPendingTable();
    const row = this._readActionPendingRow(executionId);
    if (!row) return null;
    this.sql`
      DELETE FROM cf_think_action_pending_approvals
      WHERE execution_id = ${executionId}
    `;
    return row;
  }

  private _listActionPendingRows(): ActionPendingRow[] {
    this._ensureActionPendingTable();
    return this.sql<ActionPendingRow>`
      SELECT execution_id, action_name, tool_call_id, request_id, input_json,
             descriptor_json, created_at
      FROM cf_think_action_pending_approvals
      ORDER BY created_at ASC
    `;
  }

  private _deleteActionPendingRows(executionIds: string[]): number {
    let deleted = 0;
    for (let i = 0; i < executionIds.length; i += MAX_BOUND_PARAMS) {
      const batch = executionIds.slice(i, i + MAX_BOUND_PARAMS);
      const strings = buildInClauseStrings(
        "DELETE FROM cf_think_action_pending_approvals WHERE execution_id IN ",
        batch.length
      );
      this.sql(strings, ...batch);
      deleted += batch.length;
    }
    return deleted;
  }

  private async _sweepActionPendingApprovals(options?: {
    force?: boolean;
  }): Promise<{ swept: number }> {
    this._ensureActionPendingTable();
    const ttl = this.actionPendingApprovalTtlMs;
    if (ttl === false) return { swept: 0 };
    const now = Date.now();
    if (!options?.force) {
      const lastSwept =
        (await this.ctx.storage.get<number>(ACTION_PENDING_LAST_SWEPT_KEY)) ??
        0;
      if (now - lastSwept < ACTION_PENDING_SWEEP_INTERVAL_MS) {
        return { swept: 0 };
      }
    }
    const cutoff = now - ttl;
    const rows = this.sql<{ execution_id: string }>`
      SELECT execution_id
      FROM cf_think_action_pending_approvals
      WHERE created_at < ${cutoff}
      ORDER BY created_at ASC
      LIMIT 500
    `;
    const swept = this._deleteActionPendingRows(
      rows.map((row) => row.execution_id)
    );
    await this.ctx.storage.put(ACTION_PENDING_LAST_SWEPT_KEY, now);
    if (swept > 0) {
      this._emitActionPauseEvent({
        type: "action:pause:swept",
        payload: { swept }
      });
    }
    return { swept };
  }

  // ── Durable programmatic submissions ───────────────────────────

  private _ensureSubmissionTable(): void {
    if (this._submissionTableEnsured) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_think_submissions (
        submission_id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        request_id TEXT,
        stream_id TEXT,
        status TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        metadata_json TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        messages_applied_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        -- Closed vocabulary: 'completed' | 'aborted' | 'retry'. NULL is legacy
        -- or an unsettled attempt; 'retry' is NOT terminal completion evidence.
        result_status TEXT,
        output_json TEXT,
        message_id TEXT
      )
    `;
    // This table is unversioned. Add nullable columns for existing objects,
    // preserving unstamped rows for the legacy stream-evidence fallback.
    for (const statement of [
      "ALTER TABLE cf_think_submissions ADD COLUMN result_status TEXT",
      "ALTER TABLE cf_think_submissions ADD COLUMN output_json TEXT",
      "ALTER TABLE cf_think_submissions ADD COLUMN message_id TEXT"
    ]) {
      try {
        this.ctx.storage.sql.exec(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("duplicate column")) throw error;
      }
    }
    this.sql`
      CREATE INDEX IF NOT EXISTS cf_think_submissions_status_created_idx
      ON cf_think_submissions (status, created_at, submission_id)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS cf_think_submissions_request_status_idx
      ON cf_think_submissions (request_id, status)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS cf_think_submissions_status_completed_idx
      ON cf_think_submissions (status, completed_at, created_at)
    `;
    this._submissionTableEnsured = true;
  }

  private _readSubmission(submissionId: string): ThinkSubmissionRow | null {
    this._ensureSubmissionTable();
    const rows = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at, result_status, output_json,
             message_id
      FROM cf_think_submissions
      WHERE submission_id = ${submissionId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _readSubmissionByIdempotencyKey(
    idempotencyKey: string
  ): ThinkSubmissionRow | null {
    this._ensureSubmissionTable();
    const rows = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at, result_status, output_json,
             message_id
      FROM cf_think_submissions
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _normalizeStatusFilter(
    status?: ThinkSubmissionStatus | ThinkSubmissionStatus[]
  ): Set<ThinkSubmissionStatus> | null {
    if (!status) return null;
    return new Set(Array.isArray(status) ? status : [status]);
  }

  private _listSubmissionRows(
    options?: ListSubmissionsOptions
  ): ThinkSubmissionRow[] {
    this._ensureSubmissionTable();
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    const statuses = this._normalizeStatusFilter(options?.status);
    if (statuses) {
      return [...statuses]
        .flatMap((status) => this._listSubmissionRowsByStatus(status, limit))
        .sort((a, b) =>
          b.created_at === a.created_at
            ? b.submission_id.localeCompare(a.submission_id)
            : b.created_at - a.created_at
        )
        .slice(0, limit);
    }

    const rows = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at, result_status, output_json,
             message_id
      FROM cf_think_submissions
      ORDER BY created_at DESC, submission_id DESC
      LIMIT ${limit}
    `;
    return rows;
  }

  private _listSubmissionRowsByStatus(
    status: ThinkSubmissionStatus,
    limit: number
  ): ThinkSubmissionRow[] {
    return this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at, result_status, output_json,
             message_id
      FROM cf_think_submissions
      WHERE status = ${status}
      ORDER BY created_at DESC, submission_id DESC
      LIMIT ${limit}
    `;
  }

  private _inspectionFromSubmissionRow(
    row: ThinkSubmissionRow
  ): ThinkSubmissionInspection {
    const metadata = this._parseJsonObject(row.metadata_json);
    return {
      submissionId: row.submission_id,
      idempotencyKey: row.idempotency_key ?? undefined,
      requestId: row.request_id ?? undefined,
      status: row.status,
      error: row.error_message ?? undefined,
      metadata: metadata ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      ...(row.message_id !== null && { messageId: row.message_id })
    };
  }

  private _parseJsonObject(
    value: string | null
  ): Record<string, unknown> | null {
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid metadata should not prevent inspection.
    }
    return null;
  }

  private _parseSubmissionMessages(value: string): UIMessage[] {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Stored submission messages are invalid");
    }
    return parsed as UIMessage[];
  }

  private _serializeSubmissionMessages(messages: UIMessage[]): string {
    return JSON.stringify(
      messages.map((message) =>
        enforceRowSizeLimit(sanitizeMessage(message), {
          warn: (warning) => console.warn(`[Think] ${warning}`)
        })
      )
    );
  }

  private _serializeMetadata(
    metadata: Record<string, unknown> | undefined
  ): string | null {
    return metadata === undefined ? null : JSON.stringify(metadata);
  }

  private _readWorkflowPromptContext(
    metadata: Record<string, unknown> | null
  ): ThinkWorkflowPromptContext | null {
    const workflowPromptValue = metadata?.[THINK_WORKFLOW_PROMPT_METADATA_KEY];
    if (
      workflowPromptValue === null ||
      typeof workflowPromptValue !== "object" ||
      Array.isArray(workflowPromptValue)
    ) {
      return null;
    }
    const workflowPrompt = workflowPromptValue as Record<string, unknown>;
    const workflowValue = workflowPrompt.workflow;
    if (
      workflowValue === null ||
      typeof workflowValue !== "object" ||
      Array.isArray(workflowValue)
    ) {
      return null;
    }
    const workflowRecord = workflowValue as Record<string, unknown>;
    if (
      typeof workflowRecord.name !== "string" ||
      typeof workflowRecord.id !== "string" ||
      typeof workflowRecord.stepName !== "string" ||
      typeof workflowRecord.eventType !== "string"
    ) {
      return null;
    }
    const output = workflowPrompt.output;
    const outputRecord =
      output !== null && typeof output === "object" && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : null;
    return {
      workflow: {
        name: workflowRecord.name,
        id: workflowRecord.id,
        stepName: workflowRecord.stepName,
        eventType: workflowRecord.eventType
      },
      ...(outputRecord
        ? {
            output: {
              schema: outputRecord.schema
            }
          }
        : {}),
      ...(typeof workflowPrompt.fingerprint === "string" && {
        fingerprint: workflowPrompt.fingerprint
      })
    };
  }

  private async _emitSubmissionStatus(row: ThinkSubmissionRow): Promise<void> {
    const inspection = this._inspectionFromSubmissionRow(row);
    const terminal = this._isTerminalSubmissionStatus(inspection.status);
    if (terminal) this._terminalStatusEmits.add(inspection.submissionId);
    this._emit("submission:status", {
      submissionId: inspection.submissionId,
      requestId: inspection.requestId,
      status: inspection.status
    });
    if (inspection.status === "error" && inspection.error) {
      this._emit("submission:error", {
        submissionId: inspection.submissionId,
        requestId: inspection.requestId,
        error: inspection.error
      });
      console.error("[Think] Submission failed", {
        submissionId: inspection.submissionId,
        requestId: inspection.requestId,
        idempotencyKey: inspection.idempotencyKey,
        metadata: inspection.metadata,
        error: inspection.error
      });
    }
    try {
      await this.keepAliveWhile(async () => {
        const hook = { agent: this, ended: false };
        try {
          await submissionStatusHookContext.run(hook, () =>
            this.onSubmissionStatus(inspection)
          );
        } catch (error) {
          console.error("[Think] onSubmissionStatus failed", error);
        } finally {
          hook.ended = true;
        }
      });
    } finally {
      if (terminal) {
        const id = inspection.submissionId;
        this._terminalStatusEmits.delete(id);
        const held = this._waitersHeldForDeletedEmit.get(id);
        this._waitersHeldForDeletedEmit.delete(id);
        for (const waiter of held ?? []) waiter(inspection);
        const current = this._readSubmission(id);
        if (current?.created_at === row.created_at) {
          this._resolveSubmissionWaiters(inspection);
        }
      }
    }
  }

  private _resolveSubmissionWaiters(
    submission: ThinkSubmissionInspection
  ): void {
    const waiters = this._submissionWaiters.get(submission.submissionId);
    this._submissionWaiters.delete(submission.submissionId);
    for (const waiter of waiters ?? []) waiter(submission);
  }

  private _submissionWaiters = new Map<
    string,
    Set<(submission: ThinkSubmissionInspection) => void>
  >();

  /**
   * Submissions whose row is terminal but whose `onSubmissionStatus` has not
   * finished. `waitForSubmission` keeps waiting for these.
   */
  private _terminalStatusEmits = new Set<string>();

  /** Waiters of a submission deleted while its terminal emit was in flight. */
  private _waitersHeldForDeletedEmit = new Map<
    string,
    Set<(submission: ThinkSubmissionInspection) => void>
  >();

  /**
   * Resolve once the submission reaches a terminal status (`completed`,
   * `aborted`, `skipped` or `error`), after `onSubmissionStatus` has run for
   * it. Resolves immediately for a submission that already finished, and with
   * `null` for an unknown id. An `error` status resolves rather than rejects;
   * read `status` and `error` from the result.
   *
   * The wait lives in this object's memory, so it rejects if the object
   * restarts. The submission itself is durable: call again to keep waiting.
   *
   * Throws when called from inside a turn (a tool `execute`, a lifecycle
   * hook) or from `onSubmissionStatus` for a submission that has not
   * finished: a submission only runs once the current turn frees the turn
   * queue, and its status settles only after the hook returns, so the wait
   * could never resolve. Return the submission id and wait from outside the
   * turn instead.
   */
  async waitForSubmission(
    submissionId: string,
    options?: WaitForSubmissionOptions
  ): Promise<ThinkSubmissionInspection | null> {
    const row = this._readSubmission(submissionId);
    if (!row) return null;
    if (
      this._isTerminalSubmissionStatus(row.status) &&
      !this._terminalStatusEmits.has(submissionId)
    ) {
      return this._inspectionFromSubmissionRow(row);
    }
    const hook = submissionStatusHookContext.getStore();
    if (hook?.agent === this && !hook.ended) {
      throw new Error(
        "waitForSubmission() cannot be called from onSubmissionStatus: the submission settles only after the hook returns"
      );
    }
    if (this._activeAdmittedTurn()) {
      throw new Error(
        "waitForSubmission() cannot be called from inside an active turn: the submission runs only after this turn ends"
      );
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (submission: ThinkSubmissionInspection) => {
        clearTimeout(timer);
        resolve(submission);
      };
      let waiters = this._submissionWaiters.get(submissionId);
      if (!waiters) {
        waiters = new Set();
        this._submissionWaiters.set(submissionId, waiters);
      }
      waiters.add(waiter);
      if (options?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const current = this._submissionWaiters.get(submissionId);
          current?.delete(waiter);
          if (current?.size === 0) this._submissionWaiters.delete(submissionId);
          const latest = this._readSubmission(submissionId);
          resolve(latest ? this._inspectionFromSubmissionRow(latest) : null);
        }, options.timeoutMs);
      }
    });
  }

  protected onSubmissionStatus(
    _submission: ThinkSubmissionInspection
  ): void | Promise<void> {}

  /**
   * Queue the workflow event for a submission that just went terminal.
   *
   * The item is written synchronously (the Lifecycle has started whenever a
   * submission transitions), so call this in the same synchronous block as
   * the terminal status write: the two commit together and no recovery scan
   * is needed. A repeated push for the same submission and event type
   * replaces the pending item rather than duplicating it.
   */
  private _insertWorkflowNotification(
    submission: ThinkSubmissionInspection,
    output?: unknown
  ): boolean {
    const workflowPrompt = this._readWorkflowPromptContext(
      submission.metadata ?? null
    );
    if (!workflowPrompt) return false;

    const { status, error } = submission;
    const payload = {
      submissionId: submission.submissionId,
      status,
      ...(status === "completed" && { output }),
      ...(error && { error })
    };
    void this.queue(
      WORKFLOW_NOTIFICATION_CALLBACK,
      {
        workflowName: workflowPrompt.workflow.name,
        workflowId: workflowPrompt.workflow.id,
        event: { type: workflowPrompt.workflow.eventType, payload }
      } satisfies WorkflowNotificationPayload,
      {
        id: workflowNotificationItemId(
          submission.submissionId,
          workflowPrompt.workflow.eventType
        ),
        retry: WORKFLOW_NOTIFICATION_RETRY
      }
    ).catch((error) => {
      console.error("[Think] Failed to queue workflow notification", error);
    });
    return true;
  }

  /** Queue the workflow event for a row that a caller just made terminal. */
  private _enqueueTerminalWorkflowNotification(
    row: ThinkSubmissionRow | null,
    output?: unknown
  ): void {
    if (!row || !this._isTerminalSubmissionStatus(row.status)) return;
    this._insertWorkflowNotification(
      this._inspectionFromSubmissionRow(row),
      output
    );
  }

  /**
   * Deliver one workflow notification. Runs from the queue on first
   * delivery; a failed delivery schedules this same callback again with
   * exponential backoff (2s doubling, capped at ten minutes) so a
   * temporarily unreachable workflow still gets its terminal event. Once
   * the first failure is twelve hours old delivery gives up by throwing:
   * the dispatching capability reports it through its error event and the
   * Agent's `onError`.
   * @internal Queue and schedule callback.
   */
  async _cfDeliverWorkflowNotification(
    payload: WorkflowNotificationPayload
  ): Promise<void> {
    try {
      await this.sendWorkflowEvent(
        payload.workflowName as string & {},
        payload.workflowId,
        payload.event
      );
    } catch (error) {
      const attempts = (payload.attempts ?? 0) + 1;
      const firstFailedAt = payload.firstFailedAt ?? Date.now();
      if (Date.now() - firstFailedAt >= WORKFLOW_NOTIFICATION_GIVE_UP_MS) {
        const summary =
          `Workflow notification for submission ${JSON.stringify(
            (payload.event.payload as { submissionId?: string })?.submissionId
          )} (${payload.workflowName}/${payload.workflowId}, ${payload.event.type}) ` +
          `could not be delivered after ${attempts} attempts over 12h; giving up`;
        console.error(`[Think] ${summary}`, error);
        // Deliberately no `cause`: the dispatching capability preserves any
        // error whose cause chain is a platform-class failure, which would
        // keep the item alive past this cutoff.
        throw new Error(summary);
      }
      const delaySeconds = Math.min(
        WORKFLOW_NOTIFICATION_MAX_BACKOFF_SECONDS,
        2 ** Math.min(attempts, 20)
      );
      console.error(
        `[Think] Workflow notification delivery failed (attempt ${attempts}); ` +
          `retrying in ${delaySeconds}s`,
        error
      );
      await this.schedule(delaySeconds, WORKFLOW_NOTIFICATION_CALLBACK, {
        ...payload,
        attempts,
        firstFailedAt
      } satisfies WorkflowNotificationPayload);
    }
  }

  /**
   * Move undelivered rows of the retired `cf_think_workflow_notifications`
   * outbox into the queue and drop the table. Idempotent: a missing table
   * means a fresh object or a completed migration.
   *
   * TEMPORARY: one-shot upgrade path for objects that were mid-delivery when
   * this release landed. Remove in the next minor release, once every
   * deployed object has started on this version and migrated.
   */
  private async _migrateLegacyWorkflowNotifications(): Promise<void> {
    const tables = this.ctx.storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cf_think_workflow_notifications'"
      )
      .toArray();
    if (tables.length === 0) return;

    const rows = this.sql<{
      submission_id: string;
      workflow_name: string;
      workflow_id: string;
      event_type: string;
      payload_json: string;
    }>`
      SELECT submission_id, workflow_name, workflow_id, event_type, payload_json
      FROM cf_think_workflow_notifications
      WHERE delivered_at IS NULL
      ORDER BY created_at ASC, notification_id ASC
    `;
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      await this.queue(
        WORKFLOW_NOTIFICATION_CALLBACK,
        {
          workflowName: row.workflow_name,
          workflowId: row.workflow_id,
          event: { type: row.event_type, payload }
        } satisfies WorkflowNotificationPayload,
        {
          id: workflowNotificationItemId(row.submission_id, row.event_type),
          retry: WORKFLOW_NOTIFICATION_RETRY
        }
      );
    }
    this.sql`DROP TABLE cf_think_workflow_notifications`;
  }

  async inspectSubmission(
    submissionId: string
  ): Promise<ThinkSubmissionInspection | null> {
    const row = this._readSubmission(submissionId);
    return row ? this._inspectionFromSubmissionRow(row) : null;
  }

  async listSubmissions(
    options?: ListSubmissionsOptions
  ): Promise<ThinkSubmissionInspection[]> {
    return this._listSubmissionRows(options).map((row) =>
      this._inspectionFromSubmissionRow(row)
    );
  }

  async deleteSubmission(submissionId: string): Promise<boolean> {
    const row = this._readSubmission(submissionId);
    if (!row || !this._isTerminalSubmissionStatus(row.status)) return false;
    this.sql`
      DELETE FROM cf_think_submissions
      WHERE submission_id = ${submissionId}
        AND status IN ('completed', 'aborted', 'skipped', 'error')
    `;
    this._releaseDeletedSubmissionWaiters([row]);
    return true;
  }

  private _releaseDeletedSubmissionWaiters(rows: ThinkSubmissionRow[]): void {
    for (const row of rows) {
      const id = row.submission_id;
      if (!this._terminalStatusEmits.has(id)) {
        this._resolveSubmissionWaiters(this._inspectionFromSubmissionRow(row));
        continue;
      }
      // The in-flight emit settles these after its hook; a new row that
      // reuses the id gets a fresh waiter set.
      const waiters = this._submissionWaiters.get(id);
      if (!waiters) continue;
      this._submissionWaiters.delete(id);
      const held = this._waitersHeldForDeletedEmit.get(id) ?? new Set();
      for (const waiter of waiters) held.add(waiter);
      this._waitersHeldForDeletedEmit.set(id, held);
    }
  }

  async deleteSubmissions(options?: DeleteSubmissionsOptions): Promise<number> {
    this._ensureSubmissionTable();
    const statuses =
      this._normalizeStatusFilter(options?.status) ??
      new Set<ThinkSubmissionStatus>([
        "completed",
        "aborted",
        "skipped",
        "error"
      ]);
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const completedBefore = options?.completedBefore?.getTime();
    const rows = [...statuses]
      .flatMap((status) =>
        this._listTerminalSubmissionRowsForDelete(
          status,
          limit,
          completedBefore
        )
      )
      .sort((a, b) =>
        (a.completed_at ?? a.created_at) === (b.completed_at ?? b.created_at)
          ? a.created_at - b.created_at
          : (a.completed_at ?? a.created_at) - (b.completed_at ?? b.created_at)
      )
      .slice(0, limit);

    const rowsToDelete = rows.filter((row) =>
      this._isTerminalSubmissionStatus(row.status)
    );
    const idsToDelete = rowsToDelete.map((row) => row.submission_id);

    // Batch deletes into `IN (...)` queries within the SQLite 100
    // bound-parameter limit to minimize round-trips during cleanup.
    let deleted = 0;
    for (let i = 0; i < idsToDelete.length; i += MAX_BOUND_PARAMS) {
      const batch = idsToDelete.slice(i, i + MAX_BOUND_PARAMS);
      const strings = buildInClauseStrings(
        "DELETE FROM cf_think_submissions WHERE status IN ('completed', 'aborted', 'skipped', 'error') AND submission_id IN ",
        batch.length
      );
      this.sql(strings, ...batch);
      deleted += batch.length;
    }
    this._releaseDeletedSubmissionWaiters(rowsToDelete);
    return deleted;
  }

  private _listTerminalSubmissionRowsForDelete(
    status: ThinkSubmissionStatus,
    limit: number,
    completedBefore: number | undefined
  ): ThinkSubmissionRow[] {
    if (completedBefore === undefined) {
      return this.sql<ThinkSubmissionRow>`
        SELECT submission_id, idempotency_key, request_id, stream_id, status,
               messages_json, metadata_json, error_message, created_at,
               messages_applied_at, started_at, completed_at, result_status, output_json,
             message_id
        FROM cf_think_submissions
        WHERE status = ${status}
        ORDER BY completed_at ASC, created_at ASC
        LIMIT ${limit}
      `;
    }

    return this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at, result_status, output_json,
             message_id
      FROM cf_think_submissions
      WHERE status = ${status}
        AND completed_at IS NOT NULL
        AND completed_at < ${completedBefore}
      ORDER BY completed_at ASC, created_at ASC
      LIMIT ${limit}
    `;
  }

  private _isTerminalSubmissionStatus(status: ThinkSubmissionStatus): boolean {
    return (
      status === "completed" ||
      status === "aborted" ||
      status === "skipped" ||
      status === "error"
    );
  }

  async cancelSubmission(
    submissionId: string,
    reason?: unknown
  ): Promise<CancelSubmissionResult> {
    const row = this._readSubmission(submissionId);
    if (!row) return { outcome: "not_found", submissionId };
    if (this._isTerminalSubmissionStatus(row.status)) {
      return {
        outcome: "already_terminal",
        submissionId,
        submission: this._inspectionFromSubmissionRow(row)
      };
    }
    const previousStatus = row.status as "pending" | "running";
    // Once the append loop starts it finishes even if cancelled, so starting
    // it is what applies the messages.
    let messagesApplied =
      row.messages_applied_at !== null ||
      this._submissionsApplyingMessages.has(submissionId);
    const runningHere = this._submissionAbortControllers.has(submissionId);

    const completedAt = Date.now();
    const errorMessage =
      reason === undefined
        ? null
        : reason instanceof Error
          ? reason.message
          : String(reason);
    this._submissionAbortControllers.get(submissionId)?.abort(reason);
    if (row.request_id) {
      this.abortRequest(row.request_id, reason);
    }

    this.sql`
      UPDATE cf_think_submissions
      SET status = 'aborted',
          error_message = ${errorMessage},
          completed_at = ${completedAt},
          result_status = NULL,
          output_json = NULL
      WHERE submission_id = ${submissionId}
        AND status IN ('pending', 'running')
    `;

    const updated = this._readSubmission(submissionId);
    if (!updated) return { outcome: "not_found", submissionId };
    if (updated.status !== "aborted") {
      return {
        outcome: "already_terminal",
        submissionId,
        submission: this._inspectionFromSubmissionRow(updated)
      };
    }
    this._enqueueTerminalWorkflowNotification(updated);
    this._terminalStatusEmits.add(submissionId);
    try {
      // A submission claimed before a restart has no in-memory record of its
      // appends, so fall back to the stored-message check recovery uses.
      if (!messagesApplied && previousStatus === "running" && !runningHere) {
        messagesApplied =
          (await this._getSubmissionMessagesAppliedState(updated)) !== "none";
      }
      await this.dequeue(submissionRunItemId(submissionId));
    } finally {
      await this._emitSubmissionStatus(updated);
    }
    return {
      outcome: "cancelled",
      submissionId,
      previousStatus,
      messagesApplied,
      submission: this._inspectionFromSubmissionRow(updated)
    };
  }

  async submitMessages(
    messages: UIMessage[],
    options?: SubmitMessagesOptions
  ): Promise<SubmitMessagesResult> {
    // Persist the channel on the user messages so the drained turn re-resolves
    // it from history (the model turn runs later in the submission drain).
    messages = stampTurnContext(messages, options?.channel);
    return this._admitTurn({
      admission: "submit",
      trigger: "submission",
      execute: async () => {
        this._ensureSubmissionTable();
        if (messages.length === 0) {
          throw new Error("submitMessages requires at least one message");
        }

        const existingById = options?.submissionId
          ? this._readSubmission(options.submissionId)
          : null;
        const existingByKey = options?.idempotencyKey
          ? this._readSubmissionByIdempotencyKey(options.idempotencyKey)
          : null;

        if (
          existingById &&
          existingByKey &&
          existingById.submission_id !== existingByKey.submission_id
        ) {
          throw new Error(
            "submissionId and idempotencyKey refer to different submissions"
          );
        }
        if (
          existingByKey &&
          options?.submissionId &&
          existingByKey.submission_id !== options.submissionId
        ) {
          throw new Error(
            "submissionId and idempotencyKey refer to different submissions"
          );
        }
        if (
          existingById &&
          options?.idempotencyKey &&
          existingById.idempotency_key !== null &&
          existingById.idempotency_key !== options.idempotencyKey
        ) {
          throw new Error(
            "submissionId and idempotencyKey refer to different submissions"
          );
        }

        const existing = existingById ?? existingByKey;
        if (existing) {
          if (existing.status === "pending") {
            await this._queueSubmissionRun(existing.submission_id);
          }
          return {
            ...this._inspectionFromSubmissionRow(existing),
            accepted: false
          };
        }

        const submissionId = options?.submissionId ?? crypto.randomUUID();
        const requestId = submissionId;
        const now = Date.now();
        const messagesJson = this._serializeSubmissionMessages(messages);
        const metadataJson = this._serializeMetadata(options?.metadata);

        this.sql`
      INSERT INTO cf_think_submissions (
        submission_id, idempotency_key, request_id, stream_id, status,
        messages_json, metadata_json, error_message, created_at,
        messages_applied_at, started_at, completed_at
      )
      VALUES (
        ${submissionId}, ${options?.idempotencyKey ?? null}, ${requestId},
        NULL, 'pending', ${messagesJson}, ${metadataJson}, NULL, ${now},
        NULL, NULL, NULL
      )
    `;

        const row = this._readSubmission(submissionId);
        if (!row) {
          throw new Error("Failed to persist submission");
        }

        this._emit("submission:create", {
          submissionId: row.submission_id,
          requestId: row.request_id ?? undefined,
          idempotencyKey: row.idempotency_key ?? undefined
        });
        await this._emitSubmissionStatus(row);
        await this._queueSubmissionRun(submissionId);

        return {
          ...this._inspectionFromSubmissionRow(row),
          accepted: true
        };
      }
    });
  }

  /**
   * Queue the run of one pending submission. Idempotent: the stable id
   * replaces an item already queued for the submission in place, keeping
   * its FIFO slot, and re-arms the physical alarm so a lost alarm recovers.
   */
  private async _queueSubmissionRun(submissionId: string): Promise<void> {
    await this.queue(
      SUBMISSION_RUN_CALLBACK,
      { submissionId },
      { id: submissionRunItemId(submissionId) }
    );
  }

  /** Queue a run for every pending submission that has none. */
  private async _queuePendingSubmissionRuns(): Promise<void> {
    this._ensureSubmissionTable();
    const pending = this.sql<{ submission_id: string }>`
      SELECT submission_id
      FROM cf_think_submissions
      WHERE status = 'pending'
      ORDER BY created_at ASC, submission_id ASC
    `;
    for (const row of pending) {
      await this._queueSubmissionRun(row.submission_id);
    }
  }

  /**
   * Run one pending submission. Runs on the Lifecycle alarm loop through the
   * Queue capability, one item at a time in submission order; a row that is
   * no longer pending (cancelled, skipped, or claimed by an overlapping
   * dispatch) is a no-op.
   * @internal Queue callback.
   */
  async _cfRunSubmission(payload: { submissionId: string }): Promise<void> {
    this._ensureSubmissionTable();
    const row = this._readSubmission(payload.submissionId);
    if (!row || row.status !== "pending") return;
    if (this._submissionsBehindRecovery.has(row.submission_id)) {
      // Queued again when the recovery settles.
      if (await this._chatRecoveryNames()) return;
      this._submissionsBehindRecovery.delete(row.submission_id);
    }
    await this._admitTurn({
      admission: "execute-submission",
      trigger: "submission",
      execute: () => this._executeSubmission(row)
    });
  }

  private async _executeSubmission(row: ThinkSubmissionRow): Promise<void> {
    const requestId = row.request_id ?? row.submission_id;
    const startedAt = Date.now();
    this.sql`
      UPDATE cf_think_submissions
      SET status = 'running',
          request_id = ${requestId},
          started_at = ${startedAt}
      WHERE submission_id = ${row.submission_id}
        AND status = 'pending'
    `;

    const claimed = this._readSubmission(row.submission_id);
    if (!claimed || claimed.status !== "running") return;

    // Registered before the running hook so a cancel landing during the hook
    // aborts this run and reports it as running here.
    const controller = new AbortController();
    this._submissionAbortControllers.set(row.submission_id, controller);
    let output: unknown;
    // Whether this run wrote the terminal status. A cancel or reset that got
    // there first emits it itself.
    let finalizedHere = false;
    try {
      await this._emitSubmissionStatus(claimed);
      const messages = this._parseSubmissionMessages(row.messages_json);
      const metadata = this._parseJsonObject(row.metadata_json);
      const workflowPrompt = this._readWorkflowPromptContext(metadata);
      const result = await this._runProgrammaticMessagesTurn(
        requestId,
        messages,
        {
          signal: controller.signal,
          trigger: "submission",
          captureProgrammaticStreamError: true,
          captureOutput: Boolean(workflowPrompt?.output),
          // The alarm-owned drain can inherit the ALS of a turn
          // that called `submitMessages` mid-turn (e.g. a detached-finish notify
          // from a `beforeTurn` hook). `allowNested` skips the
          // not-inside-active-turn guard for that case. Safe on every submission
          // path: nothing holding the turn queue ever awaits this turn, so the
          // queued submission simply runs once the parent turn frees the slot —
          // no deadlock, no need to scope this to detached notify.
          allowNested: true,
          workflowPrompt: workflowPrompt ?? undefined,
          shouldApplyMessages: () =>
            this._readSubmission(row.submission_id)?.status === "running",
          onApplyingMessages: () => {
            this._submissionsApplyingMessages.add(row.submission_id);
          },
          onMessagesApplied: () => {
            this.sql`
              UPDATE cf_think_submissions
              SET messages_applied_at = ${Date.now()}
              WHERE submission_id = ${row.submission_id}
                AND status = 'running'
                AND messages_applied_at IS NULL
            `;
          }
        }
      );
      output = result.output;
      if (this._recoveryOwnedSubmissions.delete(row.submission_id)) return;
      const streamId =
        this._resumableStream
          .getAllStreamMetadata()
          .find((metadata) => metadata.request_id === result.requestId)?.id ??
        null;
      const streamError = this._programmaticStreamErrors.get(result.requestId);
      const finalStatus = this._getSubmissionFinalStatus(
        result.status,
        result.error ?? streamError
      );
      const errorMessage = result.error ?? streamError ?? null;
      const completedAt = Date.now();
      this.ctx.storage.transactionSync(() => {
        finalizedHere =
          this._readSubmission(row.submission_id)?.status === "running";
        this.sql`
          UPDATE cf_think_submissions
          SET status = ${finalStatus},
              request_id = ${result.requestId},
              stream_id = ${streamId},
              error_message = ${finalStatus === "error" ? errorMessage : null},
              completed_at = ${completedAt},
              result_status = NULL,
              output_json = NULL
          WHERE submission_id = ${row.submission_id}
            AND status = 'running'
        `;
        const finalized = this._readSubmission(row.submission_id);
        if (finalized && this._isTerminalSubmissionStatus(finalized.status)) {
          this._insertWorkflowNotification(
            this._inspectionFromSubmissionRow(finalized),
            output
          );
        }
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const completedAt = Date.now();
      this.ctx.storage.transactionSync(() => {
        finalizedHere =
          this._readSubmission(row.submission_id)?.status === "running";
        this.sql`
          UPDATE cf_think_submissions
          SET status = 'error',
              error_message = ${errorMessage},
              completed_at = ${completedAt},
              result_status = NULL,
              output_json = NULL
          WHERE submission_id = ${row.submission_id}
            AND status = 'running'
        `;
        const finalized = this._readSubmission(row.submission_id);
        if (finalized && this._isTerminalSubmissionStatus(finalized.status)) {
          this._insertWorkflowNotification(
            this._inspectionFromSubmissionRow(finalized)
          );
        }
      });
    } finally {
      this._programmaticStreamErrors.delete(requestId);
      this._submissionAbortControllers.delete(row.submission_id);
      this._submissionsApplyingMessages.delete(row.submission_id);
      const updated = this._readSubmission(row.submission_id);
      if (
        finalizedHere &&
        updated &&
        this._isTerminalSubmissionStatus(updated.status)
      ) {
        await this._emitSubmissionStatus(updated);
      }
    }
  }

  private _getSubmissionFinalStatus(
    resultStatus: SaveMessagesResult["status"],
    streamError: string | undefined
  ): ThinkSubmissionStatus {
    return resultStatus === "completed" && streamError ? "error" : resultStatus;
  }

  private _markPendingSubmissionsSkipped(): ThinkSubmissionRow[] {
    this._ensureSubmissionTable();
    const pending = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at, result_status, output_json,
             message_id
      FROM cf_think_submissions
      WHERE status = 'pending'
    `;
    this.sql`
      UPDATE cf_think_submissions
      SET status = 'skipped',
          error_message = 'Submission was skipped by turn reset.',
          completed_at = ${Date.now()}
      WHERE status = 'pending'
    `;
    const skipped: ThinkSubmissionRow[] = [];
    for (const row of pending) {
      const updated = this._readSubmission(row.submission_id);
      this._enqueueTerminalWorkflowNotification(updated);
      if (updated) {
        skipped.push(updated);
        // Emitted one at a time after this returns; until each emit finishes,
        // `waitForSubmission` keeps waiting on it.
        this._terminalStatusEmits.add(updated.submission_id);
      }
      void this.dequeue(submissionRunItemId(row.submission_id)).catch(
        (error) => {
          console.error("[Think] Failed to dequeue skipped submission", error);
        }
      );
    }
    return skipped;
  }

  private async _emitSkippedSubmissions(
    skipped: ThinkSubmissionRow[]
  ): Promise<void> {
    for (const row of skipped) {
      const id = row.submission_id;
      const updated = this._readSubmission(id);
      if (
        updated?.status === "skipped" &&
        updated.created_at === row.created_at
      ) {
        try {
          await this._emitSubmissionStatus(updated);
          continue;
        } catch (error) {
          console.error("[Think] Failed to emit skipped submission", error);
        }
      }
      // Deleted or replaced before its emit (or the emit failed): settle the
      // waiters held for it so none is stranded.
      this._terminalStatusEmits.delete(id);
      const held = this._waitersHeldForDeletedEmit.get(id);
      this._waitersHeldForDeletedEmit.delete(id);
      const inspection = this._inspectionFromSubmissionRow(row);
      for (const waiter of held ?? []) waiter(inspection);
      if (updated?.created_at === row.created_at) {
        this._resolveSubmissionWaiters(inspection);
      }
    }
  }

  private async _recoverSubmissionsOnStart(): Promise<void> {
    this._ensureSubmissionTable();

    const running = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at, result_status, output_json,
             message_id
      FROM cf_think_submissions
      WHERE status = 'running'
    `;

    for (const row of running) {
      // A cutover fact wins even if an old Task/recovery callback remains.
      // Streams also complete on abort and overflow retry, so their lifecycle
      // alone cannot tell us whether this submission produced an answer.
      if (
        row.result_status === "completed" ||
        row.result_status === "aborted"
      ) {
        await this._completeRecoveredSubmission(
          row,
          row.result_status,
          row.request_id,
          null
        );
        continue;
      }
      if (row.messages_applied_at === null) {
        let appliedState: "none" | "partial" | "all";
        try {
          appliedState = await this._getSubmissionMessagesAppliedState(row);
        } catch (error) {
          this.sql`
            UPDATE cf_think_submissions
            SET status = 'error',
                error_message = ${error instanceof Error ? error.message : String(error)},
                completed_at = ${Date.now()}
            WHERE submission_id = ${row.submission_id}
              AND status = 'running'
          `;
          const updated = this._readSubmission(row.submission_id);
          if (updated?.status === "error") {
            this._enqueueTerminalWorkflowNotification(updated);
            await this._emitSubmissionStatus(updated);
          }
          continue;
        }
        if (appliedState !== "none") {
          this.sql`
            UPDATE cf_think_submissions
            SET status = 'error',
                error_message = ${appliedState === "all" ? "Submission was interrupted after messages were applied." : "Submission was interrupted after messages were partially applied."},
                completed_at = ${Date.now()}
            WHERE submission_id = ${row.submission_id}
              AND status = 'running'
          `;
          const updated = this._readSubmission(row.submission_id);
          if (updated?.status === "error") {
            this._enqueueTerminalWorkflowNotification(updated);
            await this._emitSubmissionStatus(updated);
          }
          continue;
        }
        this.sql`
          UPDATE cf_think_submissions
          SET status = 'pending',
              started_at = NULL
          WHERE submission_id = ${row.submission_id}
            AND status = 'running'
        `;
        const updated = this._readSubmission(row.submission_id);
        if (updated?.status === "pending") {
          await this._emitSubmissionStatus(updated);
        }
        continue;
      }

      if (
        row.request_id &&
        ((this._hasRecoverableChatTurn(row.request_id) &&
          this._hasFreshRecoverableSubmissionEvidence(row)) ||
          (await this._hasScheduledChatRecovery(row)))
      ) {
        continue;
      }

      // An error stamp survives its stream rows being reclaimed by a later
      // turn; pending recovery above still takes priority, so it settles the
      // ledger only once no retry remains. Legacy rows have no cutover fact;
      // keep their exact-stream fallback. An overflow segment deliberately
      // discarded its partial for a retry, so its completed stream is NOT an
      // answer — without recovery a retry stamp falls through to interruption.
      const terminalStream = row.request_id
        ? this._resumableStream.latestStreamInfoForRequest(row.request_id)
        : null;
      const errored =
        row.result_status === "error" || terminalStream?.status === "error";
      if (
        errored ||
        (terminalStream?.status === "completed" &&
          // Closed with no producer left: cut off, not answered.
          !terminalStream.cutOff &&
          row.result_status !== "retry")
      ) {
        await this._completeRecoveredSubmission(
          row,
          errored ? "error" : "completed",
          row.request_id,
          errored ? "Recovered chat stream had already errored." : null
        );
        continue;
      }

      this.sql`
        UPDATE cf_think_submissions
        SET status = 'error',
            error_message = 'Submission was interrupted after messages were applied.',
            completed_at = ${Date.now()}
        WHERE submission_id = ${row.submission_id}
          AND status = 'running'
      `;
      const updated = this._readSubmission(row.submission_id);
      if (updated?.status === "error") {
        this._enqueueTerminalWorkflowNotification(updated);
        await this._emitSubmissionStatus(updated);
      }
    }

    // Rows still pending (reverted above, or accepted before their run
    // item existed) get their run queued; queued ones keep their slot. They
    // run once no interrupted turn waits for recovery.
    for (const row of this.sql<{ submission_id: string }>`
      SELECT submission_id FROM cf_think_submissions WHERE status = 'pending'
    `) {
      this._submissionsBehindRecovery.add(row.submission_id);
    }
    await this._queuePendingSubmissionRuns();
  }

  private async _getSubmissionMessagesAppliedState(
    row: ThinkSubmissionRow
  ): Promise<"none" | "partial" | "all"> {
    const messages = this._parseSubmissionMessages(row.messages_json);
    if (messages.length === 0) return "all";

    let applied = 0;
    for (const message of messages) {
      if (await this.session.getMessage(message.id)) applied++;
    }

    if (applied === 0) return "none";
    return applied === messages.length ? "all" : "partial";
  }

  /**
   * Wall-clock creation time of a non-terminal chat-turn run on the Tasks
   * capability, or null. The metadata column holds the exact JSON the chat
   * wrapper wrote, so string equality matches the requestId.
   */
  private _recoverableChatTurnTaskCreatedAt(requestId: string): number | null {
    const rows = this.sql<{ created_at: number }>`
      SELECT created_at FROM cf_agents_task_runs
      WHERE definition = ${(this.constructor as typeof Think).CHAT_FIBER_NAME}
        AND state IN ('pending', 'running', 'waiting', 'recovering')
        AND metadata = ${JSON.stringify({ requestId })}
      LIMIT 1
    `;
    return rows[0]?.created_at ?? null;
  }

  private _hasRecoverableChatTurn(requestId: string): boolean {
    // A settled fiber whose row delete failed keeps `completed_at` (#2363).
    const fiberRows = this.sql<{ id: string }>`
      SELECT id FROM cf_agents_runs
      WHERE name = ${(this.constructor as typeof Think).CHAT_FIBER_NAME + ":" + requestId}
        AND completed_at IS NULL
      LIMIT 1
    `;
    if (fiberRows.length > 0) return true;
    if (this._recoverableChatTurnTaskCreatedAt(requestId) !== null) {
      return true;
    }

    return (
      this._resumableStream.latestActiveStreamInfoForRequest(requestId) !== null
    );
  }

  private _hasFreshRecoverableSubmissionEvidence(row: ThinkSubmissionRow) {
    if (!row.request_id) return false;
    const cutoff =
      Date.now() - (this.constructor as typeof Think).submissionRecoveryStaleMs;

    const fiberRows = this.sql<{ created_at: number }>`
      SELECT created_at FROM cf_agents_runs
      WHERE name = ${(this.constructor as typeof Think).CHAT_FIBER_NAME + ":" + row.request_id}
        AND completed_at IS NULL
      LIMIT 1
    `;
    if (fiberRows[0] && fiberRows[0].created_at >= cutoff) return true;

    const capabilityCreatedAt = this._recoverableChatTurnTaskCreatedAt(
      row.request_id
    );
    if (capabilityCreatedAt !== null && capabilityCreatedAt >= cutoff) {
      return true;
    }

    const streamInfo = this._resumableStream.latestActiveStreamInfoForRequest(
      row.request_id
    );
    return streamInfo ? streamInfo.createdAt >= cutoff : false;
  }

  private async _hasScheduledChatRecovery(
    submission: Pick<ThinkSubmissionRow, "submission_id" | "request_id">
  ): Promise<boolean> {
    const isChatRecoveryCallback = (
      callback: unknown
    ): callback is ChatRecoveryScheduleCallback =>
      callback === "_chatRecoveryContinue" || callback === "_chatRecoveryRetry";
    const matchesSubmission = (recoveredRequestId: unknown): boolean =>
      typeof recoveredRequestId === "string" &&
      this._readRunningSubmissionForRecovery(recoveredRequestId)
        ?.submission_id === submission.submission_id;

    const recoveryRuns = await this.tasks.list({
      definition: CHAT_RECOVERY_TASK_NAME,
      status: ["pending", "running", "waiting"],
      limit: Number.MAX_SAFE_INTEGER
    });
    if (
      recoveryRuns.some(
        (run) =>
          isChatRecoveryCallback(run.metadata?.callback) &&
          matchesSubmission(run.metadata.recoveredRequestId)
      )
    ) {
      return true;
    }

    // Legacy scheduled recovery callbacks remain readable while durable rows
    // created before the Tasks transport upgrade drain naturally.
    return (await this.listSchedules()).some((schedule) => {
      if (!isChatRecoveryCallback(schedule.callback)) return false;
      const payload: unknown = schedule.payload;
      return (
        payload !== null &&
        typeof payload === "object" &&
        "recoveredRequestId" in payload &&
        matchesSubmission(
          (payload as { recoveredRequestId?: unknown }).recoveredRequestId
        )
      );
    });
  }

  // ── Programmatic API ───────────────────────────────────────────

  /**
   * Inject messages and trigger a model turn — without a WebSocket request.
   *
   * Use for scheduled responses, webhook-triggered turns, proactive agents,
   * or chaining from `onChatResponse`.
   *
   * Accepts static messages or a callback that derives messages from the
   * current state (useful when multiple calls queue up — the callback runs
   * with the latest messages when the turn actually starts).
   *
   * Pass `options.signal` to cancel the turn from outside without knowing
   * the internally-generated request id. The signal is linked to the
   * registry's controller for this turn — when it aborts, the inference
   * loop's signal aborts and the result reports `status: "aborted"`.
   * A signal already aborted, or one that aborts while the turn waits in the
   * queue, stops the turn before it starts: nothing is stored and the model
   * is not called. See
   * {@link SaveMessagesOptions} for the integration point.
   *
   * @example Scheduled follow-up
   * ```typescript
   * async onScheduled() {
   *   await this.saveMessages([{
   *     id: crypto.randomUUID(),
   *     role: "user",
   *     parts: [{ type: "text", text: "Time for your daily summary." }]
   *   }]);
   * }
   * ```
   *
   * @example Function form
   * ```typescript
   * await this.saveMessages((current) => [
   *   ...current,
   *   { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Continue." }] }
   * ]);
   * ```
   *
   * @example External cancellation (helper-as-sub-agent)
   * ```typescript
   * // Inside a parent agent's tool execute — forward the AI SDK's
   * // abortSignal so a parent stop / tab close cancels the helper.
   * await helper.saveMessages([userMsg], { signal: abortSignal });
   * ```
   */
  async saveMessages(
    messages:
      | UIMessage[]
      | ((currentMessages: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    const requestId = crypto.randomUUID();
    return this._runProgrammaticMessagesTurn(requestId, messages, options);
  }

  /**
   * Add messages to history WITHOUT starting a model turn.
   *
   * Distinct from {@link Think.saveMessages} (which runs a turn) and from
   * AIChatAgent's `persistMessages()` (which replaces/reconciles a flat array):
   * `addMessages` appends or upserts into the Session tree and never enqueues a
   * turn. Because it bypasses the turn queue, it never deadlocks — including
   * when called from inside a tool `execute` during an active turn.
   *
   * Array entries are appended **linearly**: the first attaches under the
   * resolved parent (the latest committed leaf by default, or `parentId`), and
   * each subsequent message attaches under the previous one, so imported history
   * stays a single path rather than a fan-out of siblings. Appends are
   * idempotent by message id; pass `{ mode: "upsert" }` to update an existing
   * message in place instead (upsert never re-parents). Any role may be written;
   * an `assistant` message added this way is inert transcript data (it does not
   * mark a completed turn or trigger auto-continuation).
   *
   * The live message cache stays coherent automatically (the Session keeps it
   * in sync on every write, branches included). Broadcast behaviour depends on
   * whether a turn is running:
   *
   * - **Out of a turn** (the supported pattern — "add context, then run a
   *   turn"): the new messages are broadcast to connected clients immediately
   *   (unless `broadcast: false`).
   * - **Inside a turn** (e.g. from a tool `execute`): no broadcast is sent, so a
   *   full snapshot can't clobber the in-progress streamed message; the injected
   *   messages ride along on the turn's next broadcast. The write is still
   *   durable and visible to the running turn's next sync.
   */
  async addMessages(
    messages:
      | UIMessage[]
      | ((currentMessages: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: AddMessagesOptions
  ): Promise<void> {
    const resolved =
      typeof messages === "function" ? await messages(this.messages) : messages;
    if (resolved.length === 0) return;

    const mode = options?.mode ?? "append";

    // Validate an explicit parentId up front. The Session provider silently
    // falls back to the root for an unknown parent; fail fast instead so a
    // typo'd id surfaces as an error rather than a misattached message.
    if (typeof options?.parentId === "string") {
      const parent = await this.session.getMessage(options.parentId);
      if (!parent) {
        throw new Error(
          `addMessages: parentId "${options.parentId}" does not exist in this session`
        );
      }
    }

    let parentId = options?.parentId;
    for (const message of resolved) {
      const existing = await this.session.getMessage(message.id);
      if (existing) {
        // Append mode is idempotent by id (existing id → no-op); upsert updates
        // the content in place. Neither path re-parents an existing message.
        if (mode === "upsert") await this._updateMessageInHistory(message);
        parentId = message.id;
      } else {
        const stored = await this._appendMessageToHistory(message, parentId);
        parentId = stored.id;
      }
    }

    // The live cache is kept coherent automatically by the Sessions change
    // listener wired in `onStart`, which handles
    // both linear appends and branches (an explicit `parentId` triggers a full
    // resync). So `addMessages` only owns the broadcast — and suppresses it
    // mid-turn: pushing a full `MSG_CHAT_MESSAGES` snapshot while a turn streams
    // would clobber the in-progress assistant message on connected clients (the
    // same reason the streaming path defers its snapshot). The injected messages
    // ride along on the turn's next broadcast.
    if (this._insideInferenceLoop) return;
    if (options?.broadcast !== false) {
      this._broadcastMessages();
    }
  }

  private async _runProgrammaticMessagesTurn(
    requestId: string,
    messages:
      | UIMessage[]
      | ((currentMessages: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: SaveMessagesOptions & {
      onApplyingMessages?: () => void;
      onMessagesApplied?: () => void;
      captureProgrammaticStreamError?: boolean;
      captureOutput?: boolean;
      /** The body and client tools this turn runs with. See `_runServerTurn`. */
      body?: Record<string, unknown> | null;
      clientTools?: ClientToolSchema[] | null;
      workflowPrompt?: ThinkWorkflowPromptContext;
      shouldApplyMessages?: () => boolean | Promise<boolean>;
      allowNested?: boolean;
      trigger?: TurnTrigger;
      channel?: string;
    }
  ): Promise<ProgrammaticMessagesResult> {
    // Explicit channel wins; otherwise re-resolve from persisted user-message
    // metadata (covers the submission drain replaying stamped messages).
    const channel =
      options?.channel ??
      (Array.isArray(messages) ? channelFromMessages(messages) : undefined);
    return this._runServerTurn(requestId, {
      signal: options?.signal,
      spec: {
        trigger: options?.trigger ?? "programmatic",
        continuation: false,
        allowNested: options?.allowNested,
        channel
      },
      prepare: ({ isCurrent }) =>
        prepareTurnMessages({
          messages,
          current: () => this.messages,
          shouldApply: options?.shouldApplyMessages,
          isCurrent
        }),
      persist: async (resolved) => {
        options?.onApplyingMessages?.();
        for (const msg of stampTurnContext(resolved, channel)) {
          await this._appendMessageToHistory(msg);
        }
        options?.onMessagesApplied?.();
        this._broadcastMessages();
      },
      pinned: { body: options?.body, clientTools: options?.clientTools },
      model: {
        continuation: false,
        workflowPrompt: options?.workflowPrompt,
        stream: {
          captureProgrammaticStreamError:
            options?.captureProgrammaticStreamError,
          captureOutput: options?.captureOutput
        }
      }
    });
  }

  /**
   * Run one server-started turn through {@link ChatTurns.runServerTurn}.
   * `saveMessages`, `continueLastTurn` and the retry all come through here;
   * they differ in what they store first, how the turn is admitted, the
   * context they pin, and how the model turn runs.
   *
   * @param turn.pinned - The tools and body the caller passes with the turn.
   *   What it leaves out is the stored one, read when the turn starts.
   */
  private async _runServerTurn(
    requestId: string,
    turn: {
      signal?: AbortSignal;
      spec: Omit<
        QueueTurnSpec<void>,
        "admission" | "requestId" | "generation" | "getStatus" | "execute"
      >;
      prepare?: ServerChatTurn<UIMessage[]>["prepare"];
      persist?: ServerChatTurn<UIMessage[]>["persist"];
      pinned?: PinnedTurnContext;
      model: Omit<
        Parameters<Think["_runModelTurn"]>[2],
        "clientTools" | "body"
      >;
    }
  ): Promise<ProgrammaticMessagesResult> {
    // A turn chat recovery re-runs for an agent-tool run gets that run's
    // row, so the parent keeps receiving the run's frames. Any other turn
    // binds nothing.
    this._agentToolRuns.rebind(
      requestId,
      this._activeChatRecoveryRootRequestId
    );
    let output: unknown;
    const outcome = await this._turns.runServerTurn<UIMessage[]>({
      requestId,
      signal: turn.signal,
      // Under the generation the core captured: a reset while the admission
      // waits (`keepAlive`) leaves the turn stale, so the queue skips it and
      // no turn events fire for it.
      enqueue: async (run, generation) => {
        let status: ServerTurnStatus = "completed";
        const admitted = await this._admitTurn({
          ...turn.spec,
          admission: "queue",
          requestId,
          generation,
          getStatus: () => status,
          execute: async () => {
            status = await run();
          }
        });
        return admitted.status;
      },
      prepare: turn.prepare,
      persist: turn.persist,
      run: async (abortSignal) => {
        const ran = await this._runModelTurn(requestId, abortSignal, {
          ...turn.model,
          clientTools: pinnedOr(
            turn.pinned?.clientTools,
            () => this._lastClientTools
          ),
          body: pinnedOr(turn.pinned?.body, () => this._lastBody)
        });
        output = ran?.output;
        return ran;
      },
      // The turn stored its messages and was stopped before its reply. The
      // reply path records every aborted outcome (clearing the terminal
      // record of an earlier failure and the recovering indicator); with no
      // reply, that happens here.
      onAborted: () => this._recordTerminalChatStatus("aborted", requestId, "")
    });
    return {
      ...toSaveMessagesResult(requestId, outcome),
      ...withOutput(output)
    };
  }

  /**
   * The model call and reply of one turn, whatever started it: a client
   * request, `saveMessages`, `continueLastTurn`, a retry. Runs inside the
   * recovery fiber.
   *
   * The tools and body are the caller's to read, and every caller reads the
   * stored ones when its turn starts, not when the turn was queued.
   *
   * With `contextOverflow.reactive`, a reply that overflows the context
   * window is compacted and the same turn run again, up to the retry budget.
   * The reply path ends such a stream without a terminal frame, so this
   * function sends the terminal for every way the retry can end without a
   * reply: no retry left (an error frame, a terminal record, `onChatError`),
   * the turn stopped meanwhile (`aborted`, no `onChatError`, no second model
   * call), or a retry that produced no result.
   *
   * @returns The reply's outcome, or nothing when the inference loop
   *   produced no result.
   */
  private async _runModelTurn(
    requestId: string,
    abortSignal: AbortSignal | undefined,
    turn: {
      continuation: boolean;
      connection?: Connection;
      clientTools: ClientToolSchema[] | undefined;
      body: Record<string, unknown> | undefined;
      workflowPrompt?: ThinkWorkflowPromptContext;
      /** Answer this user message as a new sibling branch. */
      parentId?: string;
      stream?: {
        captureProgrammaticStreamError?: boolean;
        captureOutput?: boolean;
        extendLeafAssistant?: boolean;
      };
      /**
       * Stream the reply to an RPC caller (`chat()`). The caller is told of
       * a failure through it too.
       */
      sink?: StreamCallback;
      /** Runs the caller's client tools for a `sink` turn. */
      clientToolExecutor?: ClientToolExecutor;
    }
  ): Promise<StreamResultStatus | undefined> {
    const { continuation, parentId, sink } = turn;
    const admitted = admittedTurnContext.getStore();
    const spanAttributes = {
      "cloudflare.agents.component": "think",
      "cloudflare.agents.turn.request_id": requestId,
      "cloudflare.agents.turn.trigger": admitted?.trigger,
      "cloudflare.agents.turn.admission": admitted?.admission,
      "cloudflare.agents.turn.generation": admitted?.generation,
      "cloudflare.agents.turn.continuation": continuation
    };

    const terminal = (frame: Record<string, unknown>) =>
      this._frames.broadcast({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        done: true,
        ...frame,
        ...(continuation && { continuation: true })
      });

    const attempts = async (
      takeReply: () => Promise<void>
    ): Promise<StreamResultStatus | undefined> => {
      // Every attempt re-runs the same turn from the now-compacted history:
      // an overflow retry is not an auto-continuation.
      for (let attempt = 0; ; attempt++) {
        let result: StreamableResult;
        try {
          result = await agentContext.run(
            {
              agent: this,
              connection: turn.connection,
              request: undefined,
              email: undefined
            },
            () =>
              this._runInferenceLoop(
                {
                  signal: abortSignal,
                  clientTools: turn.clientTools,
                  clientToolExecutor: turn.clientToolExecutor,
                  body: turn.body,
                  workflowPrompt: turn.workflowPrompt,
                  continuation
                },
                parentId
              )
          );
        } catch (error) {
          // An RPC caller hears of a turn that failed before its reply
          // through its callback, not as a rejected call. A stopped turn
          // did not fail: the turn core ends it `aborted`.
          if (!sink || isTurnStopped(abortSignal)) throw error;
          const wrapped = this.onChatError(error, {
            stage: "turn",
            messagesPersisted: true
          });
          const message =
            wrapped instanceof Error ? wrapped.message : String(wrapped);
          this._emit("chat:request:failed", {
            stage: "turn",
            messagesPersisted: true,
            error: message
          });
          await sink.onError(message);
          return { status: "error", error: message };
        }

        if (!result) {
          // A client waiting on this request, or a stream an earlier attempt
          // left open, still needs its terminal frame. Nobody waits on a
          // continuation by its request id: its tabs are released when the
          // turn settles.
          if ((turn.connection && !continuation) || attempt > 0) {
            terminal({ body: "No response was generated." });
          }
          return undefined;
        }
        // A turn that continues the latest reply takes it over from a
        // scheduled recovery at the stream's first chunk with content
        // (`beforeContent`). The stream is lazy: a provider error arrives
        // inside it, and leaves the recovery in place.

        // The reply path suppresses a classified overflow whenever recovery
        // is enabled; this loop owns the retry-or-terminal call, so every
        // overflow terminal is reported the same way.
        let overflowError: string | undefined;
        let overflowRequested = false;
        let overflowPartial: UIMessage | undefined;
        const overflowRecovery = this._overflowReactiveEnabled
          ? {
              onRetry: (error: string | undefined, partial: UIMessage) => {
                overflowRequested = true;
                overflowError = error;
                overflowPartial = partial;
              }
            }
          : undefined;

        const streamResult = await this._withAgentSpan(
          "persist_chat_result",
          "turn",
          spanAttributes,
          async (): Promise<StreamResultStatus> => {
            const streamed = await this._pumpReply(
              requestId,
              result,
              abortSignal,
              {
                ...turn.stream,
                continuation,
                parentId,
                overflowRetry: overflowRecovery !== undefined,
                beforeContent: takeReply,
                sink
              }
            );
            if (streamed.status === "overflow_retry") {
              overflowRecovery?.onRetry(streamed.error, streamed.partial);
              return { status: "aborted" };
            }
            if (streamed.status === "interrupted") {
              return { status: "aborted", reason: "interrupted" };
            }
            return streamed;
          }
        );

        if (!overflowRequested) return streamResult;

        if (attempt < this._overflowMaxRetries && !abortSignal?.aborted) {
          const shortened = await this._withAgentSpan(
            "compact_chat_history",
            "turn",
            spanAttributes,
            () =>
              this._compactForContextOverflow("reactive", {
                requestId,
                attempt: attempt + 1
              })
          );
          // Compaction shortened history: run the turn again, unless it was
          // stopped while compacting. A no-op compaction can't fix the
          // overflow, so that falls through to terminal too.
          if (shortened && !abortSignal?.aborted) continue;
        }
        // The reply path left this turn without its terminal: no frame, no
        // terminal record, no `onChatResponse`. Every turn that ends gets
        // all three, here, whatever started it.
        const end = async (
          status: "aborted" | "error",
          error?: string
        ): Promise<StreamResultStatus> => {
          terminal(
            status === "error"
              ? { body: error, error: true }
              : { body: "", outcome: "aborted" }
          );
          // Records the terminal status, then calls `onChatResponse` with
          // what the last attempt streamed.
          await this._fireLiveResponseHook({
            message: overflowPartial ?? {
              id: crypto.randomUUID(),
              role: "assistant",
              parts: []
            },
            requestId,
            continuation,
            status,
            ...(error !== undefined && { error })
          });
          // An RPC caller hears a failure through its callback.
          if (status === "error") await sink?.onError(error ?? "");
          return { status, ...(error !== undefined && { error }) };
        };
        if (abortSignal?.aborted) {
          // Stopped at the overflow or while compacting: the caller asked
          // for a stop, so that is what it is told.
          return end("aborted");
        }
        // Budget spent or compaction no-op: surface terminally through
        // onChatError (classified), so the turn never loops or ends silently
        // with no answer.
        return end(
          "error",
          this._finalizeContextOverflowError(requestId, overflowError)
        );
      }
    };

    return this._runChatRecoveryFiber(
      requestId,
      continuation,
      attempts,
      parentId,
      { clientTools: turn.clientTools, body: turn.body }
    );
  }

  /**
   * Run a new LLM call following the last assistant message.
   *
   * The model sees the full conversation (including the last assistant
   * response) and generates a new response. The new response is persisted
   * as a separate assistant message. Building block for chat recovery
   * (Phase 4), "generate more" buttons, and self-correction.
   *
   * Note: this creates a new message, not an append to the existing one.
   * Recovery continuations (`trigger: "recovery-continue"`) are the exception:
   * they stream into the interrupted assistant message so it stays one message.
   *
   * Returns early with `status: "skipped"` if there is no assistant message
   * to continue from.
   *
   * Pass `options.signal` to cancel the continuation from outside —
   * matches the {@link saveMessages} contract.
   */
  protected async continueLastTurn(
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions & { trigger?: TurnTrigger; channel?: string }
  ): Promise<SaveMessagesResult> {
    const store = continuationOutputContext.getStore();
    const capture = store?.agent === this && !store.taken ? store : undefined;
    if (capture) capture.taken = true;
    const full = await this._continueLastTurn(
      body,
      capture ? { ...options, captureOutput: true } : options
    );
    if (capture) capture.result = full;
    const { output: _output, ...result } = full;
    return result;
  }

  private async _continueLastTurn(
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions &
      PinnedTurnContext & {
        trigger?: TurnTrigger;
        channel?: string;
        captureOutput?: boolean;
      }
  ): Promise<ProgrammaticMessagesResult> {
    const trigger = options?.trigger ?? "programmatic";
    this._assertNotInsideAdmittedTurn(trigger);
    const lastLeaf = await this.session.getLatestLeaf();
    if (!lastLeaf || lastLeaf.role !== "assistant") {
      return {
        requestId: "",
        status: "skipped",
        reason: "nothing-to-continue"
      };
    }

    const requestId = crypto.randomUUID();
    const workflowPrompt = this._recoveredWorkflowPrompt();
    const captureOutput =
      options?.captureOutput || Boolean(workflowPrompt?.output);
    let emptyReplyRemoved = false;
    const result = await this._runServerTurn(requestId, {
      signal: options?.signal,
      spec: {
        trigger,
        continuation: true,
        // Without an explicit channel, a continued/recovered turn re-applies
        // the per-channel policy of the turn it extends.
        channel: options?.channel,
        inheritChannel: options?.channel === undefined
      },
      pinned: {
        body: body ?? options?.body,
        clientTools: options?.clientTools
      },
      // Decided first, at the front of the queue, before the turn stores
      // anything: while the reply still waits on a client there is nothing
      // to continue, and a skipped call leaves the chat as it found it. The
      // client's answer starts the continuation.
      // A reply that holds nothing once its trailing reasoning is gone has
      // nothing to continue either. It is removed, and the question it
      // answered is answered again below, as recovery does for a lost reply.
      prepare: async () => {
        if (this._turns.continuationWaitsOnClient()) {
          return { declined: "skipped", reason: "awaiting-client" };
        }
        emptyReplyRemoved = await this._turns.removeEmptyReplyToContinue(
          this.messages,
          this._repairedTranscriptSink()
        );
        return emptyReplyRemoved
          ? { declined: "skipped", reason: "nothing-to-continue" }
          : { input: [] };
      },
      model: {
        continuation: true,
        workflowPrompt,
        stream: {
          extendLeafAssistant: trigger === "recovery-continue",
          captureOutput
        }
      }
    });
    if (!emptyReplyRemoved) return result;
    const retried = await this._retryLastUserTurn({
      signal: options?.signal,
      body: body ?? options?.body,
      clientTools: options?.clientTools,
      channel: options?.channel,
      trigger: trigger === "recovery-continue" ? "recovery-retry" : trigger
    });
    return retried.status === "skipped" && retried.reason === undefined
      ? { ...retried, reason: "nothing-to-continue" }
      : retried;
  }

  private async _retryLastUserTurn(
    options?: SaveMessagesOptions &
      PinnedTurnContext & {
        trigger?: TurnTrigger;
        channel?: string;
        /** Answer this user message as a new sibling branch (a regeneration). */
        branchParentId?: string;
      }
  ): Promise<SaveMessagesResult> {
    const trigger = options?.trigger ?? "recovery-retry";
    this._assertNotInsideAdmittedTurn(trigger);
    const branchParentId = options?.branchParentId;
    const target =
      branchParentId === undefined
        ? await this.session.getLatestLeaf()
        : await this.session.getMessage(branchParentId);
    if (!target || target.role !== "user") {
      return { requestId: "", status: "skipped" };
    }

    const requestId = crypto.randomUUID();
    // Re-resolve the channel from the persisted user message so a recovered
    // retry re-applies per-channel policy, exactly like `continueLastTurn`. The
    // `metadata.channel` stamp survives the interruption; without this the
    // retried turn would silently fall back to the default policy.
    const channel = options?.channel ?? channelFromMessages(this.messages);
    const workflowPrompt = this._recoveredWorkflowPrompt();

    const { output: _output, ...result } = await this._runServerTurn(
      requestId,
      {
        signal: options?.signal,
        spec: { trigger, continuation: false, channel },
        pinned: { body: options?.body, clientTools: options?.clientTools },
        model: {
          continuation: false,
          workflowPrompt,
          parentId: branchParentId,
          stream: { captureOutput: Boolean(workflowPrompt?.output) }
        }
      }
    );
    return result;
  }

  // ── WebSocket protocol ──────────────────────────────────────────

  private _setupProtocolHandlers() {
    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (
      connection: Connection,
      ctx: { request: Request }
    ) => {
      const requestTargetsSubAgent = this._cf_requestTargetsSubAgent(
        ctx.request
      );
      if (requestTargetsSubAgent) {
        return _onConnect(connection, ctx);
      }

      if (this._resumableStream.hasActiveStream()) {
        // A stream is still in flight. The resume flow is the
        // authoritative source of state: `_notifyStreamResuming` tells
        // the client to send `STREAM_RESUME_ACK`, after which the
        // server replays buffered chunks and delivers a final
        // `MSG_CHAT_MESSAGES` broadcast once the turn completes.
        //
        // Sending `MSG_CHAT_MESSAGES` here would clobber the in-progress
        // assistant the client rebuilds from the replayed chunks,
        // because `this.messages` at this point still only contains
        // the user message — the assistant message is not persisted
        // until the stream finishes.
        //
        // Except while requests wait behind the stream: the tab is sent the
        // list first, before the replay starts, so it knows which messages
        // are queued and draws them after the reply.
        if (this._turns.queuedMessageIds().size > 0) {
          connection.send(
            JSON.stringify({
              type: MSG_CHAT_MESSAGES,
              connect: true,
              ...this._turns.connectView(this.messages)
            })
          );
        }
        this._notifyStreamResuming(connection);
      } else {
        // No active stream. If a turn is accepted but its stream hasn't started
        // yet (#1784), park this connection and tell it to keep waiting (`park`
        // sends the keep-waiting frame; no-op otherwise). Either way send the
        // idle-connect transcript so the client renders the user message it
        // just submitted while it waits for the stream to begin.
        this._preStream.park(connection);
        for (const message of await this._buildIdleConnectMessages()) {
          connection.send(JSON.stringify(message));
        }
      }
      return _onConnect(connection, ctx);
    };

    const _onClose = this.onClose.bind(this);
    this.onClose = async (
      connection: Connection,
      code: number,
      reason: string,
      wasClean: boolean
    ) => {
      releaseChatConnection(
        this._turns,
        this._pendingResumeConnections,
        connection.id
      );
      return _onClose(connection, code, reason, wasClean);
    };

    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (
        !this._cf_connectionTargetsSubAgent(connection) &&
        (await dispatchChatProtocol(connection, message, this._chatProtocol))
      ) {
        return;
      }
      return _onMessage(connection, message);
    };

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = async (request: Request) => {
      const url = new URL(request.url);
      if (
        url.pathname === "/get-messages" ||
        url.pathname.endsWith("/get-messages")
      ) {
        // The stored messages only. A tab learns of queued ones over its
        // socket, where they are named as queued.
        return Response.json(this.messages);
      }
      const messengerResponse =
        await this._messengerRuntime?.handleRequest(request);
      if (messengerResponse) {
        return messengerResponse;
      }
      return _onRequest(request);
    };
  }

  /** What the shared chat protocol dispatch calls on this agent. */
  private _chatProtocolInstance: ChatProtocolHost<Connection> | undefined;
  private get _chatProtocol(): ChatProtocolHost<Connection> {
    this._chatProtocolInstance ??= {
      turns: this._turns,
      requestContext: this._requestContext,
      resumeHandshake: () => this._resumeHandshake(),
      emit: (type, payload) => this._emit(type, payload),
      chatRequest: (connection, request) =>
        this._withAgentSpan(
          "chat_interaction",
          "interaction",
          {
            "cloudflare.agents.component": "think",
            "cloudflare.agents.turn.request_id": request.requestId
          },
          () => this._handleChatRequest(connection, request)
        ),
      frames: this._frames,
      rejectedChatRequest: (_connection, rejection) => {
        const wrapped = this.onChatError(
          rejection.error ?? new Error(rejectionMessage(rejection)),
          {
            requestId: rejection.requestId,
            stage: "parse",
            messagesPersisted: false
          }
        );
        const error =
          wrapped instanceof Error ? wrapped.message : String(wrapped);
        this._emit("chat:request:failed", {
          requestId: rejection.requestId,
          stage: "parse",
          messagesPersisted: false,
          error
        });
        return error;
      },
      clear: (connection) => this._handleClear(connection),
      messages: async () => {
        if (!this._loggedProtocolWarnings.has("client-pushed-messages")) {
          this._loggedProtocolWarnings.add("client-pushed-messages");
          console.warn(
            "[think] Ignoring client-pushed chat messages; Think is " +
              "server-authoritative and does not persist flat transcript " +
              "overwrites. Use @cloudflare/think/react so setMessages stays " +
              "local-only, and use clearHistory() for persisted clears."
          );
        }
      },
      applyToolResult: (event) =>
        this._applyToolUpdateToMessages(
          toolResultUpdate(
            event.toolCallId,
            event.output,
            event.state as "output-error" | undefined,
            event.errorText
          )
        ),
      applyToolApproval: (event) =>
        this._applyToolUpdateToMessages(
          toolApprovalUpdate(event.toolCallId, event.approved, event.approvalId)
        ),
      continuation: (connection) => this._continuationSpec(connection),
      enqueueInteraction: (run) => this._enqueueInteractionOutcome(run)
    };
    return this._chatProtocolInstance;
  }

  private async _handleChatRequest(
    connection: Connection,
    request: ParsedChatRequest
  ) {
    const {
      messages: incomingMessages,
      clientTools: rawClientTools,
      body: customBody
    } = request;
    const isRegeneration = request.trigger === "regenerate-message";
    const requestId = request.requestId;
    const requestOriginIds = originMessageIds(incomingMessages);
    if (requestOriginIds) {
      this._frames.requestOrigins.set(requestId, requestOriginIds);
    }

    // The turn core runs the request: decide, accept (pre-stream mark and
    // abort controller, so a cancel while it waits in the queue is not lost),
    // persist, queue, the queued checks, then the turn. It always settles the
    // pre-stream turn (#1784) and drops the abort controller.
    try {
      await this._turns.runClientRequest(
        this._clientChatRequest({
          requestId,
          isRegeneration,
          messages: incomingMessages,
          clientTools: rawClientTools,
          body: customBody,
          connection,
          branchParentId: isRegeneration
            ? incomingMessages.at(-1)?.id
            : undefined,
          originMessageIds: requestOriginIds
        })
      );
    } finally {
      this._frames.requestOrigins.delete(requestId);
    }
  }

  /**
   * One client chat request, as the turn core runs it: decide, accept
   * (pre-stream mark and abort controller, so a cancel while it waits in the
   * queue is not lost), record it for a replay after a reset, persist,
   * queue, the queued checks, then the turn. It always settles the
   * pre-stream turn (#1784) and drops the abort controller.
   *
   * The request's new user messages wait on its record until its turn
   * starts (`join`), so the turn running now never sees them and the turn
   * that answers them reads them last.
   *
   * A replay after an isolate reset (`messages: null`) has no connection:
   * its messages are on its record, and its frames go to every connection.
   */
  private _clientChatRequest(input: {
    requestId: string;
    isRegeneration: boolean;
    /** What the client sent, or `null` for a replay. */
    messages: UIMessage[] | null;
    clientTools: ClientToolSchema[] | undefined;
    body: Record<string, unknown>;
    connection: Connection | null;
    /** A regenerate: the message whose reply it replaces. */
    branchParentId: string | undefined;
    originMessageIds: string[] | undefined;
  }): ClientChatRequest<{
    branchParentId: string | undefined;
    generation: number;
  }> {
    const {
      requestId,
      isRegeneration,
      messages: incomingMessages,
      clientTools: rawClientTools,
      body: customBody,
      connection
    } = input;
    const isSubmitMessage = !isRegeneration;
    // Messages other waiting requests hold are theirs, even when this tab
    // drew them and sent them back.
    const queued = incomingMessages ? this._turns.queuedMessageIds() : null;
    const sent = incomingMessages?.filter((m) => !queued?.has(m.id)) ?? [];
    const heldIds = new Set(
      newUserMessageIds(
        sent,
        new Set(this.messages.map((message) => message.id))
      )
    );
    const held = sent.filter((message) => heldIds.has(message.id));
    // Lists naming queued messages once this request was shown to the
    // other tabs.
    let queuedViewsAtAccept = 0;
    return {
      requestId,
      admission: {
        messages: held,
        payload: {
          trigger: isRegeneration ? "regenerate-message" : "submit-message",
          clientTools: rawClientTools,
          body: customBody,
          originMessageIds: input.originMessageIds,
          branchParentId: input.branchParentId
        } satisfies StoredThinkClientRequest
      },
      isSubmitMessage,
      concurrency: this.messageConcurrency,
      onDropped: () => {
        if (connection) this._rollbackDroppedSubmit(connection);
        this._completeSkippedRequest(connection, requestId);
      },
      // A genuinely-new turn supersedes any pending terminal record (#1645)
      // so a stale exhaustion can't replay over the resume handshake to a
      // client that reconnects between this submit being accepted and the
      // new turn streaming.
      onAccepted: () =>
        this._withAgentSpan(
          "clear_previous_chat_state",
          "interaction",
          {
            "cloudflare.agents.component": "think",
            "cloudflare.agents.turn.request_id": requestId,
            "cloudflare.agents.turn.trigger": "ws-chat"
          },
          () => this._clearChatTerminal()
        ),
      persist: async ({ generation, isCurrent }) => {
        // A replay after a reset: its messages are on its record.
        if (!incomingMessages) {
          return { branchParentId: input.branchParentId, generation };
        }
        // ── Reconcile, persist, and broadcast user messages ──────────
        //
        // The client may post an in-flight assistant snapshot it minted
        // optimistically (e.g. while a previous tool call is still
        // streaming). Reconcile against the server's current active path
        // so client IDs map onto server IDs and stale client states pick
        // up the server's tool outputs. Without this, Session's
        // INSERT-OR-IGNORE-by-ID would persist a duplicate orphan
        // assistant row alongside the real server-generated one.
        const reconciledTurn = await this._reconcileAndPersistIncoming(sent, {
          requestId,
          isRegeneration,
          isCurrent,
          channel: "web",
          hold: heldIds
        });
        if (!reconciledTurn) return null;

        // Other tabs see the new messages as queued.
        this._broadcastMessages(connection ? [connection.id] : []);
        queuedViewsAtAccept = this._turns.queuedViews;
        return { branchParentId: reconciledTurn.branchParentId, generation };
      },
      // The turn is at the front of the queue: its new messages join the
      // session under the latest leaf (the reply of the turn it waited
      // behind), and the other tabs are told.
      join: async ({ messages, isCurrent }) => {
        // Stored already, by a join before a reset.
        if (messages.length === 0) return isCurrent();
        const joined = await this._withAgentSpan(
          "persist_incoming_messages",
          "turn",
          {
            "cloudflare.agents.component": "think",
            "cloudflare.agents.turn.request_id": requestId,
            "cloudflare.agents.turn.trigger": "ws-chat"
          },
          async () => {
            for (const message of messages as UIMessage[]) {
              if (!isCurrent()) return false;
              await this._persistIncomingMessage(message, undefined, "web");
            }
            if (!isCurrent()) return false;
            if (!this._cfTranscript.coversActivePath)
              await this._cfTranscript.sync();
            return true;
          }
        );
        // The tab that sent them draws them already, unless it was since
        // shown them as queued.
        if (joined) {
          this._broadcastMessages(
            connection && this._turns.queuedViews === queuedViewsAtAccept
              ? [connection.id]
              : []
          );
        }
        return joined;
      },
      enqueue: (turn, generation, onQueued) =>
        this.keepAliveWhile(async () => {
          const result = await this._admitTurn({
            admission: "queue",
            trigger: "ws-chat",
            requestId,
            generation,
            continuation: false,
            channel: "web",
            onQueued,
            execute: turn
          });
          return result.status;
        }),
      onSkipped: () => this._completeSkippedRequest(connection, requestId),
      // Cancelled before its turn started: the model is never called. Like
      // a skipped request it never streamed, so only the tab that sent it
      // was ever shown it.
      onCancelledBeforeStart: () =>
        this._frames.endUnstarted(connection, requestId, "aborted"),
      run: async ({ branchParentId }, abortSignal) => {
        // The request's tools and body become the stored request context
        // now that its turn runs. Storing them when the request was
        // accepted would change what a continuation of the turn still
        // running uses, and a request cancelled or skipped in the queue
        // would leave its context behind.
        // The request's tools and body become the stored request context
        // now that its turn runs. A request that sends no client tools
        // clears the stored ones: the tools a turn offers the model are
        // the ones the client that sent the request can run.
        const { clientTools: clientToolsForTurn, body: bodyForTurn } =
          this._withAgentSpan(
            "persist_chat_request_context",
            "turn",
            {
              "cloudflare.agents.component": "think",
              "cloudflare.agents.turn.request_id": requestId,
              "cloudflare.agents.turn.trigger": "ws-chat"
            },
            () =>
              this._requestContext.set({
                clientTools: rawClientTools,
                body: customBody
              })
          );
        await this._runModelTurn(requestId, abortSignal, {
          continuation: false,
          connection: connection ?? undefined,
          clientTools: clientToolsForTurn,
          body: bodyForTurn,
          parentId: branchParentId
        });
      },
      // Persist the terminal error before broadcasting it: the broadcast is
      // transient, so a client disconnected at this moment (a pre-stream
      // failure like message reconciliation) would otherwise never learn the
      // turn failed and stay frozen on reconnect (see `_buildIdleConnectMessages`).
      onError: async (error, stage) => {
        await this._turns.reportTurnFailure(this._turnFailureHost(), {
          requestId,
          error,
          continuation: false,
          stage
        });
      }
    };
  }

  /**
   * Abort the active turn, invalidate queued turns, and reset
   * concurrency/continuation state. Call this when intercepting
   * clear events or implementing custom reset logic.
   *
   * Does NOT clear messages, streams, or persisted state —
   * only turn execution state.
   */
  protected resetTurnState(): void {
    // Queue generation, abort controllers, submit concurrency, the tool-result
    // apply chain, the continuation slots and barrier, and parked connections.
    this._turns.reset();
    this._agentToolRuns.chatReset();
    for (const controller of this._submissionAbortControllers.values()) {
      controller.abort(new Error("Turn state reset"));
    }
    this._submissionAbortControllers.clear();
    const skippedSubmissions = this._markPendingSubmissionsSkipped();
    void this.keepAliveWhile(() =>
      this._emitSkippedSubmissions(skippedSubmissions)
    ).catch((error) => {
      console.error("[Think] Failed to skip pending submissions", error);
    });
    this._lastTurnChannel = undefined;
  }

  /**
   * Abort a single in-flight chat turn by request id.
   *
   * Equivalent to the cancel path that fires when a client sends a
   * `chat-request-cancel` WebSocket message — the inference loop's
   * signal aborts, partial chunks already streamed are still
   * persisted, and the turn's `ChatResponseResult` reports
   * `status: "aborted"`.
   *
   * No-op if no controller exists for `requestId` (the turn already
   * completed, was never started, or used a different id).
   *
   * `chat()` callers can read the request id from
   * {@link StreamCallback.onStart} and later pass it here from another
   * RPC call.
   *
   * Prefer {@link SaveMessagesOptions.signal} when driving a turn
   * programmatically — it threads the abort intent in from the start
   * without requiring the caller to know the id.
   */
  cancelChat(requestId: string, reason?: string): void {
    const settled = this._turns.cancel(requestId, reason);
    void this.keepAliveWhile(() => settled);
  }

  /**
   * What every stop does beyond aborting a running turn, whichever way the
   * stop came in (a client's cancel, {@link cancelChat},
   * {@link abortRequest}, {@link abortAllRequests}, a caller's `signal`):
   *
   * - an agent-tool run whose turn the stop names is cancelled, so a run
   *   left open for chat recovery is settled and its parent stops waiting;
   * - a recovery of the request that is waiting out its backoff, with
   *   nothing in flight to abort, is cancelled, so its callback bails when
   *   it fires.
   *
   * @param requestId - The stopped request, or `null` for every request.
   */
  private async _afterStop(
    requestId: string | null,
    reason: unknown
  ): Promise<void> {
    this._agentToolRuns.stopped(requestId, reason);
    if (requestId !== null) {
      await this._chatRecoveryEngine().tryCancelScheduledRecovery(requestId);
    }
  }

  /**
   * Abort every in-flight chat turn on this agent, and drop every
   * auto-continuation that waits to run, whether a turn is running or not.
   */
  cancelAllChats(): void {
    this._stopEveryChat();
  }

  /**
   * A stop of everything (`ChatTurns.stopAll`): every turn is aborted and
   * every waiting continuation dropped. The connection-less continuation
   * waits as a queue item until its callback runs. It is not dequeued here:
   * a read and a dequeue would leave a window in which an approval pushed
   * after the stop replaces the item and is dequeued with it. The stop count
   * is durable, the item carries the count it was pushed under, and its
   * callback drops an item pushed before a later stop
   * ({@link _cfRunConnectionlessContinuation}). A push after the stop
   * carries the new count and runs.
   */
  private _stopEveryChat(): void {
    this._cfConfig.set(
      CONNECTIONLESS_STOPS_KEY,
      String(this._connectionlessStops() + 1)
    );
    const settled = this._turns.stopAll();
    void this.keepAliveWhile(() => settled);
  }

  /**
   * Stops of every chat ({@link _stopEveryChat}), durable so an item pushed
   * before an eviction is still known to come before a later stop.
   */
  private _connectionlessStops(): number {
    const stops = Number(this._cfConfig.get(CONNECTIONLESS_STOPS_KEY) ?? 0);
    return Number.isFinite(stops) ? stops : 0;
  }

  protected abortRequest(requestId: string, reason?: unknown): void {
    const settled = this._turns.cancel(requestId, reason);
    void this.keepAliveWhile(() => settled);
  }

  /**
   * Abort every in-flight chat turn on this agent.
   *
   * Aborts all controllers in the registry and clears it. Used by
   * subclasses that drive single-purpose turns (e.g. a sub-agent
   * helper that runs one turn at a time over RPC) and want a coarse
   * "cancel whatever is running" handle without tracking request ids.
   *
   * A turn still waiting in the queue is aborted too: it ends `aborted`
   * when it reaches the front, stores nothing and does not call the model.
   *
   * Every auto-continuation that waits to run is dropped too, whether a
   * turn is running or not. A tool result that arrives afterwards continues
   * as usual.
   *
   * Does NOT invalidate queued turns or submit concurrency state — use
   * {@link resetTurnState} for the full teardown that runs on `chat-clear`.
   */
  protected abortAllRequests(): void {
    this._stopEveryChat();
  }

  private async _handleClear(connection?: Connection) {
    this.resetTurnState();

    this._resumableStream.clearAll();
    this._pendingResumeConnections.clear();
    this._requestContext.clear();
    await this._clearHistory();
    this._broadcast(
      { type: MSG_CHAT_CLEAR },
      connection ? [connection.id] : undefined
    );
  }

  private _annotateActionApprovalChunk(
    requestId: string,
    chunk: StreamChunkData,
    pendingActionCalls: Map<
      string,
      { toolName: string; input: unknown | undefined; inputText?: string }
    >,
    parts?: UIMessage["parts"]
  ): StreamChunkData {
    const toolCallId =
      typeof chunk.toolCallId === "string"
        ? chunk.toolCallId
        : typeof chunk.id === "string"
          ? chunk.id
          : undefined;

    if (toolCallId) {
      if (
        (chunk.type === "tool-input-start" ||
          chunk.type === "tool-input-available" ||
          chunk.type === "tool-call") &&
        typeof chunk.toolName === "string"
      ) {
        const previous = pendingActionCalls.get(toolCallId);
        pendingActionCalls.set(toolCallId, {
          toolName: chunk.toolName,
          input:
            "input" in chunk
              ? normalizeToolInput(chunk.input).input
              : previous?.input
        });
      } else if ("input" in chunk) {
        const previous = pendingActionCalls.get(toolCallId);
        if (previous) {
          pendingActionCalls.set(toolCallId, {
            ...previous,
            input: normalizeToolInput(chunk.input).input
          });
        }
      } else if (
        chunk.type === "tool-input-delta" &&
        typeof chunk.inputTextDelta === "string"
      ) {
        const previous = pendingActionCalls.get(toolCallId);
        if (previous) {
          pendingActionCalls.set(toolCallId, {
            ...previous,
            inputText: (previous.inputText ?? "") + chunk.inputTextDelta
          });
        }
      }
    }

    // A durable pause (durable-pause action OR codemode execution) surfaces as
    // a `tool-output-available` chunk whose output is `status: "paused"`, NOT a
    // `tool-approval-request`. Attach the approval descriptor here so the paused
    // transcript part renders consistently in every approval UI.
    if (chunk.type === "tool-output-available" && toolCallId) {
      const descriptor = this._descriptorForPausedOutput(
        requestId,
        toolCallId,
        (chunk as { output?: unknown }).output
      );
      return descriptor ? { ...chunk, approvalDescriptor: descriptor } : chunk;
    }

    if (chunk.type !== "tool-approval-request" || !toolCallId) return chunk;

    const storedDescriptor =
      this._activeTurnActionApprovalDescriptors.get(toolCallId);
    if (storedDescriptor) {
      return {
        ...chunk,
        approvalDescriptor: storedDescriptor
      };
    }

    let pending = pendingActionCalls.get(toolCallId);
    if (!pending && parts) {
      const part = parts.find(
        (candidate) =>
          "toolCallId" in candidate && candidate.toolCallId === toolCallId
      ) as Record<string, unknown> | undefined;
      if (typeof part?.toolName === "string") {
        pending = {
          toolName: part.toolName,
          input: "input" in part ? normalizeToolInput(part.input).input : {}
        };
      }
    }
    if (!pending) return chunk;

    const metadata = this._activeTurnActionMetadata.get(pending.toolName);
    if (!metadata) return chunk;

    const descriptor: ActionApprovalDescriptor = {
      requestId,
      toolCallId,
      action: metadata.actionName,
      summary: metadata.summary,
      input:
        pending.input ??
        (pending.inputText !== undefined
          ? normalizeToolInput(pending.inputText).input
          : {}),
      permissions: metadata.permissions ?? [],
      ...(metadata.risk !== undefined && { risk: metadata.risk }),
      kind: metadata.kind
    };

    return {
      ...chunk,
      approvalDescriptor: descriptor
    };
  }

  /**
   * Build the approval descriptor for a paused tool output, the single source
   * of truth for rendering a pending approval. Durable-pause actions read the
   * descriptor persisted on their pending row (resolved permissions, survives
   * compaction); codemode pauses derive `connector.method` from the first
   * pending action and let {@link describePausedExecution} enrich it. Returns
   * `undefined` for non-paused outputs or when no descriptor can be built.
   */
  private _descriptorForPausedOutput(
    requestId: string,
    toolCallId: string,
    output: unknown
  ): ActionApprovalDescriptor | undefined {
    if (typeof output !== "object" || output === null) return undefined;
    const o = output as {
      status?: unknown;
      executionId?: unknown;
      pending?: unknown;
    };
    if (o.status !== "paused") return undefined;
    const executionId =
      typeof o.executionId === "string" ? o.executionId : undefined;

    if (executionId?.startsWith(ACTION_PAUSE_ID_PREFIX)) {
      const row = this._readActionPendingRow(executionId);
      if (!row?.descriptor_json) return undefined;
      try {
        return JSON.parse(row.descriptor_json) as ActionApprovalDescriptor;
      } catch {
        return undefined;
      }
    }

    const pending = Array.isArray(o.pending)
      ? (o.pending as import("@cloudflare/codemode").PendingAction[])
      : [];
    const first = pending[0];
    if (!first) return undefined;
    const label = `${first.connector}.${first.method}`;
    const base: ActionApprovalDescriptor = {
      requestId,
      toolCallId,
      action: label,
      summary: label,
      input: first.args,
      permissions: [],
      kind: "durable-pause"
    };
    const override = this.describePausedExecution(pending, {
      requestId,
      toolCallId
    });
    if (!override) return base;
    return {
      ...base,
      ...override,
      // Identity fields are ours to set — an override can't retarget the part.
      requestId,
      toolCallId
    };
  }

  private _applyActionApprovalDescriptorToParts(
    chunk: StreamChunkData,
    parts: UIMessage["parts"]
  ): void {
    if (
      (chunk.type !== "tool-approval-request" &&
        chunk.type !== "tool-output-available") ||
      typeof chunk.toolCallId !== "string" ||
      chunk.approvalDescriptor === undefined
    ) {
      return;
    }
    const part = parts.find(
      (candidate) =>
        "toolCallId" in candidate && candidate.toolCallId === chunk.toolCallId
    ) as Record<string, unknown> | undefined;
    if (!part) return;
    if (chunk.type === "tool-approval-request") {
      // A genuine AI SDK approval request: the descriptor rides on the
      // approval object (which also carries the eventual decision).
      part.approval = {
        ...(part.approval as Record<string, unknown> | undefined),
        descriptor: chunk.approvalDescriptor
      };
      return;
    }
    // A durable pause (durable-pause action / codemode) is a SETTLED
    // `output-available` part, not an AI SDK approval. Putting the descriptor
    // on `part.approval` would make `convertToModelMessages` emit a
    // `tool-approval-request` for an already-resolved output on the next turn
    // (an invalid prompt). Use a sibling field conversion ignores instead.
    part.approvalDescriptor = chunk.approvalDescriptor;
  }

  /**
   * Run one reply through the shared pump (`pumpReply`): store and send its
   * chunks, store it, send its terminal frame. A `sink` also gets the chunks
   * and the end (`chat()` over RPC).
   */
  private async _pumpReply(
    requestId: string,
    result: StreamableResult,
    abortSignal: AbortSignal | undefined,
    options: {
      continuation?: boolean;
      parentId?: string;
      captureProgrammaticStreamError?: boolean;
      captureOutput?: boolean;
      /**
       * A context overflow the app classifies as such returns
       * `overflow_retry`, so the driver can compact and run the turn again.
       * Pass only while the retry budget allows.
       */
      overflowRetry?: boolean;
      /**
       * Stream into the assistant leaf (same id, existing parts) instead of a
       * new assistant message. Recovery continuations set this so an
       * interrupted answer stays one message (#1876); other continuations keep
       * the documented `continueLastTurn()` behavior of a separate message.
       */
      extendLeafAssistant?: boolean;
      /**
       * Runs once, before the first chunk that carries content
       * (`takeAtFirstContent`).
       */
      beforeContent?: () => Promise<void>;
      sink?: StreamCallback;
    } = {}
  ): Promise<ReplyResult> {
    const continuation = options.continuation ?? false;
    const { parentId, sink } = options;
    const leaf = this.messages.at(-1);
    const extend =
      continuation && options.extendLeafAssistant && leaf?.role === "assistant"
        ? leaf
        : undefined;
    const isReset = this._turns.turnResetGuard();
    const pendingActionCalls = new Map<
      string,
      { toolName: string; input: unknown | undefined; inputText?: string }
    >();
    const persisted = (id: string | undefined) => {
      if (id !== undefined) this._broadcastMessages();
      return id;
    };
    const host: ReplyPumpHost = {
      streams: this._replyStreams,
      send: (frame) => this._frames.broadcast(frame),
      broadcastTranscript: () => this._broadcastMessages(),
      emit: ({ type, ...event }) => this._emit(type, event as never),
      turns: this._turns,
      stallTimeoutMs:
        this._activeStallTimeoutMs ?? this.chatStreamStallTimeoutMs,
      classify: (error, inBand) => {
        if (!inBand) {
          return this.#overflow.transientClassification(error, requestId)
            ? "transient"
            : "terminal";
        }
        const classification = this.#overflow.classifyStreamError(
          error,
          requestId
        );
        if (
          options.overflowRetry &&
          this.#overflow.isRecoverable(classification)
        ) {
          return "overflow";
        }
        return isTransientClassification(classification) &&
          !isDurableObjectResetError(error)
          ? "transient"
          : "terminal";
      },
      describeError: (error) => {
        const wrapped = this.onChatError(error, {
          requestId,
          stage: "stream",
          messagesPersisted: true
        });
        return wrapped === error
          ? streamErrorText(error)
          : wrapped instanceof Error
            ? wrapped.message
            : String(wrapped);
      },
      transformChunk: (chunk, parts) =>
        this._annotateActionApprovalChunk(
          requestId,
          chunk,
          pendingActionCalls,
          parts
        ),
      afterApply: (chunk, parts) =>
        this._applyActionApprovalDescriptorToParts(chunk, parts),
      applyToolUpdate: (update) => this._applyToolUpdateToMessages(update),
      settleInterruptedReply: (message) =>
        this._settleInterruptedReply(message, requestId),
      store: async (message, context) => {
        if (context.kind === "partial") {
          return persisted(
            (await this._persistAssistantMessage(message, parentId))
              ? message.id
              : undefined
          );
        }
        if (context.kind === "again") {
          const toPersist = this._strippedForPersist(message);
          if (toPersist === null) return undefined;
          this._patchCachedMessage(
            await this._updateMessageInHistory(toPersist)
          );
          return persisted(toPersist.id);
        }
        try {
          await this._rememberPendingResponseHook(context.response);
          // The await above is a storage write. The input gate holds new
          // events while it is pending, but work already running can still
          // clear the chat in it. Check again before the write.
          if (isReset()) {
            await this._forgetPendingResponseHook(requestId).catch(() => {});
            return undefined;
          }
          const id = await this._persistAssistantMessageWithCutover(
            context.streamId,
            message,
            parentId,
            this._streamCutoverOptions(requestId),
            { requestId, result: context.result }
          );
          if (context.response.status === "completed" && id !== undefined) {
            const capture = waitTurnResultContext.getStore();
            if (capture?.agent === this) capture.messageIds.set(requestId, id);
          }
          return persisted(id);
        } catch (error) {
          await this._forgetPendingResponseHook(requestId).catch(() => {});
          throw error;
        }
      },
      route: (interruption) =>
        this._routeStreamInterruption({
          requestId,
          streamId: interruption.streamId,
          backoff: interruption.backoff,
          error: interruption.error,
          retryAfterSeconds: this._streamErrorRetryAfter(interruption.error),
          onPartialDropped: interruption.dropPartial,
          partialParts: interruption.partialParts,
          branchParentId: parentId,
          persistPartial: interruption.keepPartial
        }),
      settled: (response) => this._fireLiveResponseHook(response),
      finalized: (rearm) => {
        if (rearm) this._flushResolvedPausesAfterReply();
      },
      reading: (active) => {
        this._insideInferenceLoop = active;
      }
    };
    const replied = await pumpReply(
      {
        requestId,
        source: uiMessageStreamSource(result, () =>
          this._drainInferenceStream(result)
        ),
        signal: abortSignal,
        messageId: crypto.randomUUID(),
        continuation,
        extend,
        parentId,
        onFirstContent: options.beforeContent,
        overflowRetry: options.overflowRetry,
        ...(options.captureOutput &&
          result.output && {
            output: async () => await result.output
          }),
        ...(sink && {
          sink: {
            chunk: async (body) => {
              await sink.onEvent(body);
            },
            done: async () => {
              await sink.onDone();
            },
            error: async (message) => {
              await sink.onError(message);
            },
            interrupted: async () => {
              await sink.onInterrupted?.(
                this._messengerRecoveryClaims.delete(requestId)
                  ? { deliversRecoveredReply: true }
                  : undefined
              );
            }
          }
        })
      },
      host
    );
    if (replied.status === "error" && options.captureProgrammaticStreamError) {
      this._programmaticStreamErrors.set(requestId, replied.error);
    }
    return replied;
  }

  // ── Session-backed persistence ──────────────────────────────────

  /**
   * Single source of Think's strip + empty-skip persistence rule. Strips the
   * internal final-answer parts and returns the message to persist (the stripped
   * copy, or the original when nothing was stripped), or `null` when stripping
   * leaves nothing user-facing (only structural `step-start` markers, or
   * nothing) — in which case the caller skips persistence so a structured
   * workflow turn does not leave an empty assistant message in the conversation.
   * Shared by `_persistAssistantMessage` and the orphan-persist path so the rule
   * cannot drift between the live and recovery writes.
   */
  private _strippedForPersist(msg: UIMessage): UIMessage | null {
    const stripped = withoutFinalAnswerParts(msg);
    // A reply that holds nothing a client can show and nothing a model
    // request can carry is not stored (the shared `replyIsEmpty`): one cut
    // off while the model was still reasoning, or one that was only an
    // internal final answer.
    return replyIsEmpty(stripped) ? null : stripped;
  }

  /**
   * Settle the tool calls a cut-off reply left unanswered (the shared
   * `settleInterruptedReply`): a call no client is known to own becomes an
   * errored result through {@link repairInterruptedToolPart}. Call it on a
   * reply whose stream did not finish, before it is stored.
   */
  private _settleInterruptedReply(
    message: UIMessage,
    requestId?: string
  ): UIMessage {
    // A turn that runs with pinned tools (a recovered turn, an agent-tool
    // run) owns the client calls those tools name, not the stored ones.
    const live =
      requestId === undefined
        ? undefined
        : this._chatTurnFibers.requestContext(requestId);
    const pinned =
      live !== undefined && live.lastClientTools !== this._lastClientTools
        ? clientResolvableToolNames(live.lastClientTools ?? undefined)
        : undefined;
    return this._turns.settleInterruptedReply(
      message,
      (part) => this.repairInterruptedToolPart(part),
      pinned
    );
  }

  /**
   * Settle and store the reply a recovery attempt is about to continue,
   * before the attempt waits for the chat to be stable. That reply was cut
   * off by definition. One this version stored is settled already; one an
   * older version stored may hold a server tool call nothing will answer,
   * and the attempt would otherwise wait on it as if a client could.
   *
   * Earlier replies are left alone. The conversation has moved past them, so
   * nothing waits on them, and the turn that follows settles what they left
   * unanswered.
   */
  private _settleBeforeRecovery(
    continueReplyId: string,
    removal?: ReplyRemoval
  ): Promise<"removed" | undefined> {
    return this._turns.settleBeforeRecovery(
      () => this.messages,
      continueReplyId,
      (part) => this.repairInterruptedToolPart(part),
      this._repairedTranscriptSink(),
      removal
    );
  }

  /** Resolves to `false` when stripping left nothing to persist. */
  private async _persistAssistantMessage(
    msg: UIMessage,
    parentId?: string
  ): Promise<boolean> {
    const toPersist = this._strippedForPersist(msg);
    if (toPersist === null) return false;
    await this._upsertMessageInHistory(toPersist, parentId);
    return true;
  }

  /**
   * The cutover: persist the finished turn's assistant message, settle its
   * resumable stream and delete the stream's rows in ONE SQLite transaction,
   * so a crash leaves either the live stream (recovery rebuilds the message
   * from it) or the message — never neither, never both. The session
   * change feed and auto-compaction run once the transaction has committed.
   */
  private async _persistAssistantMessageWithCutover(
    streamId: string,
    msg: UIMessage,
    parentId?: string,
    options: { discard?: boolean } = {},
    submission?: { requestId: string; result: SubmissionTurnResult }
  ): Promise<string | undefined> {
    const toPersist = this._strippedForPersist(msg);
    if (toPersist === null) return undefined;
    if (this._resumableStream.pendingCutoverId !== streamId) {
      // The stream was settled by another path (a stall, an error): plain persist.
      await this._upsertMessageInHistory(toPersist, parentId);
      if (submission) {
        this._recordSubmissionMessage(submission.requestId, toPersist.id);
      }
      return toPersist.id;
    }
    const sync = this.sessions.session().__DO_NOT_USE_WILL_BREAK__sync();
    let after: (() => Promise<void>) | undefined;
    try {
      this._resumableStream.cutover(
        streamId,
        () => {
          after = sync.upsert(toPersist as SessionMessage, {
            parentId,
            source: "server"
          }).after;
          if (submission) {
            this._recordSubmissionTurnResult(
              submission.requestId,
              submission.result,
              toPersist.id
            );
          }
        },
        options
      );
    } catch (error) {
      // The settle transaction rolled back: the row never landed, but the
      // session's in-memory caches already counted it.
      sync.abandon();
      throw error;
    }
    await after?.();
    return toPersist.id;
  }

  /**
   * Whether this turn's stream rows can go with its cutover. An agent-tool
   * child turn keeps them: the parent tails the stored chunks after the
   * child completes (`getAgentToolChunks`), so the rows are reclaimed by
   * the child's next `start()` instead, as `AIChatAgent` does. A running
   * submission needs no stream evidence: its durable outcome stamp commits
   * in the same transaction as this cutover.
   */
  private _streamCutoverOptions(requestId: string): { discard: boolean } {
    return { discard: !this._agentToolRuns.runsByRequestId.get(requestId) };
  }

  /** Write only inside the transaction that settles this exact request's stream. */
  private _recordSubmissionTurnResult(
    requestId: string,
    result: SubmissionTurnResult,
    messageId?: string
  ): void {
    const row = this._readRunningSubmissionForRecovery(requestId);
    if (!row || row.request_id !== requestId) {
      if (messageId) this._recordAbortedSubmissionMessage(requestId, messageId);
      return;
    }
    this.sql`
      UPDATE cf_think_submissions
      SET result_status = ${result.status},
          output_json = ${result.status === "completed" && result.output !== undefined ? JSON.stringify(result.output) : null},
          message_id = COALESCE(${messageId ?? null}, message_id)
      WHERE submission_id = ${row.submission_id} AND status = 'running'
    `;
  }

  private _recordSubmissionMessage(requestId: string, messageId: string): void {
    const row = this._readRunningSubmissionForRecovery(requestId);
    if (!row || row.request_id !== requestId) {
      this._recordAbortedSubmissionMessage(requestId, messageId);
      return;
    }
    this.sql`
      UPDATE cf_think_submissions
      SET message_id = ${messageId}
      WHERE submission_id = ${row.submission_id} AND status = 'running'
    `;
  }

  /**
   * Cancellation settles a submission as `aborted` before the stream persists
   * its partial; link that message without touching the terminal status. A
   * row that never started (a reused submission id cancelled while queued)
   * cannot own the partial.
   */
  private _recordAbortedSubmissionMessage(
    requestId: string,
    messageId: string
  ): void {
    this.sql`
      UPDATE cf_think_submissions
      SET message_id = ${messageId}
      WHERE request_id = ${requestId}
        AND status = 'aborted'
        AND started_at IS NOT NULL
        AND message_id IS NULL
    `;
  }

  /**
   * Remove parts belonging to Think's internal structured-output final-answer
   * tool (`think_final_answer`, or a collision-suffixed variant) from a UI
   * message so the internal call/result never enters the persisted conversation
   * (and is never re-fed to the model on later turns). Stateless and matched by
   * the reserved name so it also covers recovery re-persist paths. Handles both
   * the static (`tool-<name>`) and dynamic (`dynamic-tool`) part shapes the AI
   * SDK can emit.
   */
  /**
   * Turn-start persistence of the client's transcript: reconcile the posted
   * messages against the server's active path, write only what changed, and
   * leave the live cache current. Returns `null` when a newer request
   * superseded this one part-way through (`isCurrent` turned false).
   *
   * Storage traffic here is independent of transcript length: the server
   * transcript comes from the live cache when it covers the path, unchanged
   * echoed messages are skipped before Sessions is asked, and the cache is
   * re-read only when it is windowed.
   */
  private async _reconcileAndPersistIncoming(
    incomingMessages: UIMessage[],
    options: {
      requestId: string;
      isRegeneration: boolean;
      isCurrent: () => boolean;
      /** Channel stamped on user messages the server has not stored yet. */
      channel?: string;
      /**
       * Messages a waiting request holds: they shape the reconcile and the
       * branch point, and are not stored here.
       */
      hold?: ReadonlySet<string>;
    }
  ): Promise<{ branchParentId: string | undefined } | null> {
    const spanAttributes = {
      "cloudflare.agents.component": "think",
      "cloudflare.agents.turn.request_id": options.requestId,
      "cloudflare.agents.turn.trigger": "ws-chat"
    };
    const serverMessages = await this._withAgentSpan(
      "load_chat_history",
      "interaction",
      spanAttributes,
      () => this._serverTranscriptForReconcile()
    );
    const serverMessagesById = new Map(
      serverMessages.map((message) => [message.id, message])
    );
    // A client's copy of a reply can be behind the stored one (the tab that
    // pressed stop has one chunk fewer). It never shortens the stored reply.
    const reconciled = keepStoredReplies(
      keepResolvedPauses(
        reconcileMessages(incomingMessages, serverMessages, sanitizeMessage),
        serverMessages
      ),
      serverMessages
    );

    let branchParentId: string | undefined;
    if (options.isRegeneration && reconciled.length > 0) {
      branchParentId = reconciled[reconciled.length - 1].id;
    }

    const persisted = await this._withAgentSpan(
      "persist_incoming_messages",
      "interaction",
      spanAttributes,
      async () => {
        if (!options.isCurrent()) return false;

        for (const msg of reconciled) {
          if (!options.isCurrent()) return false;
          if (options.hold?.has(msg.id)) continue;
          await this._persistIncomingMessage(
            msg,
            serverMessagesById,
            options.channel
          );
        }

        if (!options.isCurrent()) return false;
        // The change feed patched the cache for every write above (a linear
        // append lands in place; a branch append already forced a full
        // refresh), so a cache that covers the path is current. Only a
        // windowed or unhydrated cache needs storage to re-derive its view.
        if (!this._cfTranscript.coversActivePath) {
          await this._cfTranscript.sync();
        }
        return true;
      }
    );
    return persisted ? { branchParentId } : null;
  }

  /**
   * The server transcript that reconciliation diffs client messages against.
   * The live cache answers when it holds the whole active path — the common
   * case, kept current by the change feed after every durable write. A
   * windowed or unhydrated cache falls back to the full storage read, since
   * reconciliation must see every message (`_readMessagesFromStorage`).
   *
   * Returns a snapshot: the writes that follow patch the cache through the
   * change feed while the caller is still iterating.
   */
  private async _serverTranscriptForReconcile(): Promise<UIMessage[]> {
    if (this._cfTranscript.coversActivePath)
      return [...this._cfTranscript.messages];
    return this._readMessagesFromStorage();
  }

  /**
   * Persist an incoming message after batch reconciliation has resolved
   * assistant IDs and merged server-owned tool outputs. An unchanged message
   * is skipped (see `incomingMessageWrite`).
   */
  private async _persistIncomingMessage(
    msg: UIMessage,
    serverMessagesById?: ReadonlyMap<string, UIMessage>,
    channel?: string
  ): Promise<void> {
    const write = incomingMessageWrite(
      sanitizeMessage(msg),
      msg,
      serverMessagesById?.get(msg.id),
      channel
    );
    if (write) {
      await this._upsertMessageInHistory(
        write.message,
        undefined,
        write.source
      );
    }
  }

  // ── Tool state updates (shared primitives from agents/chat) ─────

  /**
   * Serialize a client-tool result/approval apply behind any in-flight apply
   * (#1649). Parallel tool results arrive as independent WebSocket messages,
   * and each apply is a read-modify-write of the full message in durable
   * storage. Running them concurrently means every apply reads the same
   * snapshot (all siblings still `input-available`), patches only its own part,
   * and writes the whole message back — so the last write clobbers the others
   * back to `input-available`, and the auto-continuation barrier later times
   * out and the transcript-repair backstop errors the lost siblings.
   *
   * Chaining each apply off `_interactionApplyTail` makes the read-modify-write
   * atomic per result and in arrival order. `_pendingInteractionPromise` is set
   * to the newest link so the barrier's single-slot wake-up still observes the
   * latest apply; because the chain is serial, awaiting it transitively waits
   * for every predecessor.
   *
   * @internal
   */
  protected _enqueueInteractionApply(
    apply: () => Promise<void>
  ): Promise<boolean> {
    return this._turns.enqueueInteraction(async () => {
      await apply();
      return true;
    });
  }

  /**
   * Queue a client tool result or approval through
   * {@link _enqueueInteractionApply}, the hook a subclass can wrap, and
   * report whether its tool call was found.
   */
  private async _enqueueInteractionOutcome(
    run: () => Promise<boolean>
  ): Promise<boolean> {
    let found = false;
    await this._enqueueInteractionApply(async () => {
      found = await run();
    });
    return found;
  }

  // ── Durable execution approvals (codemode HITL) ──────────────────
  //
  // A `requiresApproval` connector call inside the execute tool pauses the
  // run *durably*: the tool returns `{ status: "paused", executionId,
  // pending }` as a normal output, the model narrates what it needs, and the
  // turn ends. These callables are the resume path: approve/reject the
  // pending action on the codemode runtime, replace the paused output in the
  // transcript with the new outcome, and auto-continue so the model sees it.

  /**
   * The codemode runtime handle behind the execute tool. `this.codemode` is
   * assigned when `createExecuteRuntime(this)` / `createExecuteTool(this)`
   * runs (normally at turn start, via `getTools()`); after a DO restart no
   * turn may have run yet, so fall back to building the tools once.
   */
  private _codemodeRuntime():
    | import("@cloudflare/codemode").CodemodeRuntimeHandle
    | undefined {
    if (!this.codemode) {
      try {
        this.getTools();
      } catch {
        // getTools may require turn-time context; without it there is
        // simply no runtime to resolve.
      }
    }
    return this.codemode;
  }

  /**
   * Pending (awaiting-approval) actions across paused executions of the
   * execute tool's codemode runtime — `{ executionId, seq, connector,
   * method, args }` each, with FULL args (the transcript copy is truncated).
   * Clients reconcile approval cards against this on load.
   *
   * Client-callable (registered below — see the `callable()` calls after the
   * class body).
   */
  async pendingExecutions(
    executionId?: string
  ): Promise<import("@cloudflare/codemode").PendingAction[]> {
    const runtime = this._codemodeRuntime();
    if (!runtime) return [];
    return runtime.pending(executionId);
  }

  /**
   * List everything awaiting human approval — parked `kind: "durable-pause"`
   * actions and paused codemode executions — each carrying its
   * {@link ActionApprovalDescriptor}. The unified, descriptor-first view a
   * dashboard, voice backend, or messenger reconciles against; resolve any of
   * them via {@link approveExecution} / {@link rejectExecution}. Pass an
   * `executionId` to scope to one.
   *
   * Client-callable.
   */
  async pendingApprovals(executionId?: string): Promise<PendingApproval[]> {
    const out: PendingApproval[] = [];

    for (const row of this._listActionPendingRows()) {
      if (executionId && row.execution_id !== executionId) continue;
      if (!row.descriptor_json) continue;
      let descriptor: ActionApprovalDescriptor;
      try {
        descriptor = JSON.parse(
          row.descriptor_json
        ) as ActionApprovalDescriptor;
      } catch {
        continue;
      }
      out.push({
        executionId: row.execution_id,
        source: "action",
        descriptor
      });
    }

    const runtime = this._codemodeRuntime();
    if (runtime) {
      const pending = await runtime.pending(executionId);
      const seen = new Set<string>();
      for (const action of pending) {
        if (seen.has(action.executionId)) continue;
        seen.add(action.executionId);
        const group = pending.filter(
          (candidate) => candidate.executionId === action.executionId
        );
        const toolCallId =
          this._findExecutionToolCall(action.executionId) ?? "";
        const descriptor = this._descriptorForPausedOutput("", toolCallId, {
          status: "paused",
          executionId: action.executionId,
          pending: group
        });
        if (descriptor) {
          out.push({
            executionId: action.executionId,
            source: "codemode",
            descriptor
          });
        }
      }
    }

    return out;
  }

  /**
   * Approve a paused execution and resume it. The run continues from where
   * it stopped (replaying logged work, executing the approved call); the
   * outcome — completed, errored, or paused again on the NEXT gated call —
   * replaces the paused tool output in the transcript and the chat
   * auto-continues so the model can act on it.
   *
   * Approving an execution that is no longer pending (already settled,
   * expired, or unknown) returns `{ status: "error" }` with an explanatory
   * message — it never throws.
   *
   * Client-callable.
   */
  async approveExecution(executionId: string): Promise<unknown> {
    // Durable-pause action approvals own the `actpause_` id space and resolve
    // against the pending-approval store, not the codemode runtime.
    if (executionId.startsWith(ACTION_PAUSE_ID_PREFIX)) {
      return await this._approveActionPause(executionId);
    }
    const runtime = this._codemodeRuntime();
    if (!runtime) {
      return {
        status: "error",
        executionId,
        error:
          "No codemode runtime is configured — the execute tool was never " +
          "created on this agent."
      };
    }
    const output = truncatePausedExecutionOutput(
      await runtime.approve({ executionId })
    );
    await this._applyExecutionOutcome(executionId, output);
    return output;
  }

  /**
   * Approve a parked `kind: "durable-pause"` action and run its `execute`.
   *
   * Claim-by-delete makes this idempotent across tabs/recovery: only the caller
   * that removes the row runs the action; a racing approve/reject sees no row
   * and reports "already resolved". Authorization happened at PAUSE time — the
   * human approval is the authority now, so we do not re-authorize (the turn
   * context that `authorizeAction` needs is gone). The action runs through the
   * ledger so its side effect stays replay-safe, the outcome replaces the
   * paused transcript part, and the chat continues even with no socket open.
   */
  private async _approveActionPause(executionId: string): Promise<unknown> {
    const row = this._claimActionPendingRow(executionId);
    if (!row) {
      return {
        status: "error",
        executionId,
        error: `Execution "${executionId}" is no longer pending — it was approved or rejected elsewhere.`
      };
    }

    const action = await this._findRegisteredAction(row.action_name);
    if (!action) {
      const output = {
        status: "error",
        executionId,
        action: row.action_name,
        error:
          `Action "${row.action_name}" is no longer registered, so the ` +
          `approved call cannot run. The approval was consumed.`
      };
      await this._applyExecutionOutcome(executionId, output);
      return output;
    }

    let input: unknown;
    try {
      input = JSON.parse(row.input_json);
    } catch {
      input = {};
    }

    const output = await this._runApprovedActionPause(action, row, input);
    this._emitActionPauseEvent({
      type: "action:pause:approved",
      payload: { action: row.action_name, executionId }
    });
    await this._applyExecutionOutcome(executionId, output);
    return output;
  }

  /** Resolve a registered action by its resolved name (config.name ?? key). */
  private async _findRegisteredAction(name: string): Promise<Action | null> {
    const actions = await this.getActions();
    for (const [registrationName, candidate] of Object.entries(actions)) {
      if (!isAction(candidate)) continue;
      const resolved = candidate.config.name ?? registrationName;
      if (resolved === name) return candidate;
    }
    return null;
  }

  /**
   * Run a just-approved durable-pause action's `execute` through the ledger.
   * Mirrors the inline `_actionToTool` execute wrapper (timeout, abort race,
   * model-output prep) MINUS authorization — that was settled at pause time.
   */
  private async _runApprovedActionPause(
    action: Action,
    row: ActionPendingRow,
    input: unknown
  ): Promise<unknown> {
    const config = action.config;
    const executeAction = config.execute as (
      input: unknown,
      ctx: ActionContext
    ) => Promise<unknown> | unknown;
    const idempotencyKey = config.idempotencyKey as
      | ActionIdempotencyKey<unknown>
      | undefined;
    const { signal, cleanup } = createActionAbortSignal(
      undefined,
      config.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS
    );
    const ctx: ActionContext = {
      agent: this,
      env: this.env as Cloudflare.Env,
      requestId: row.request_id ?? "",
      toolCallId: row.tool_call_id,
      messages: [],
      signal,
      // No-op: a durable-pause approved action is delivered by a later
      // continuation turn (different requestId), so a same-turn attachment
      // can't be delivered in v1.
      attachReply: () => {}
    };
    const abortError = () =>
      signal.reason instanceof Error
        ? signal.reason
        : new Error(signal.reason ? String(signal.reason) : "Action aborted");
    let onAbort: (() => void) | undefined;
    try {
      if (signal.aborted) throw abortError();
      const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const runAction = async () => {
        const out = await Promise.race([
          Promise.resolve(executeAction(input, ctx)),
          abortPromise
        ]);
        return prepareActionOutputForModel(out);
      };
      return await this._runLedgeredAction({
        toolName: row.action_name,
        idempotencyKey,
        input,
        ctx,
        runAction
      });
    } catch (error) {
      return actionErrorEnvelope(error);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      cleanup();
    }
  }

  /**
   * Reject a paused execution's pending action, ending the run. The
   * transcript's paused output is replaced with
   * `{ status: "rejected", executionId, reason }` and the chat
   * auto-continues so the model can adapt (or explain) instead of erroring.
   * Pass `{ autoContinue: false }` to record the rejection without starting a
   * model continuation.
   *
   * Client-callable.
   */
  async rejectExecution(
    executionId: string,
    reason?: string,
    options?: RejectExecutionOptions
  ): Promise<unknown> {
    if (executionId.startsWith(ACTION_PAUSE_ID_PREFIX)) {
      return await this._rejectActionPause(executionId, reason, options);
    }
    const runtime = this._codemodeRuntime();
    if (!runtime) {
      return {
        status: "error",
        executionId,
        error:
          "No codemode runtime is configured — the execute tool was never " +
          "created on this agent."
      };
    }
    const pending = await runtime.pending(executionId);
    if (pending.length === 0) {
      return {
        status: "error",
        executionId,
        error: `Execution "${executionId}" is no longer pending.`
      };
    }
    // `reject` reports whether it actually terminated the run. A `false`
    // means the action was resolved between our `pending()` check and the
    // reject (approve/reject interleave across facet RPC awaits — input
    // gates only cover storage). Writing "rejected" then would clobber a
    // paused part whose real outcome (e.g. an in-flight approval) is still
    // coming, so surface an error instead.
    const terminated = await runtime.reject({
      executionId,
      seq: pending[0].seq
    });
    if (!terminated) {
      return {
        status: "error",
        executionId,
        error: `Execution "${executionId}" is no longer pending — it was approved or rejected elsewhere.`
      };
    }
    const output = {
      status: "rejected",
      executionId,
      reason: reason ?? "Rejected by user"
    };
    await this._applyExecutionOutcome(executionId, output, options);
    return output;
  }

  /**
   * Reject a parked `kind: "durable-pause"` action. Claim-by-delete consumes
   * the pending row (idempotent across tabs/recovery), the action's `execute`
   * never runs, and the paused transcript part is replaced with a `rejected`
   * outcome so the model can adapt or explain.
   */
  private async _rejectActionPause(
    executionId: string,
    reason?: string,
    options?: RejectExecutionOptions
  ): Promise<unknown> {
    const row = this._claimActionPendingRow(executionId);
    if (!row) {
      return {
        status: "error",
        executionId,
        error: `Execution "${executionId}" is no longer pending — it was approved or rejected elsewhere.`
      };
    }
    const output = {
      status: "rejected",
      executionId,
      action: row.action_name,
      reason: reason ?? "Rejected by user"
    };
    this._emitActionPauseEvent({
      type: "action:pause:rejected",
      payload: { action: row.action_name, executionId }
    });
    await this._applyExecutionOutcome(executionId, output, options);
    return output;
  }

  /**
   * Replace a paused execute-tool or durable-action output in the transcript
   * with the execution's new outcome and kick the auto-continuation so the
   * model sees it.
   *
   * When no paused part carries `executionId` — the output was already
   * replaced from another tab, or compaction summarized the part away — the
   * runtime has still durably applied the approval/rejection, so the outcome
   * must not be dropped: it is appended as a framework-authored system note,
   * and the continuation still fires so the model can act on it. Provider
   * assembly projects this narrowly identified note to ordinary user context
   * without changing its durable authorship.
   *
   * The outcome is applied like a client tool result
   * (`ChatTurns.applyInteraction`), and its continuation is one like any
   * other: it answers the message the outcome is stored in (the paused
   * call's message, or the note), and runs only while that message is the
   * latest and has not gone on to an answer. An approval that arrives after
   * the conversation moved on is not lost: the outcome is stored, the next
   * turn's model call reads it, and `chat:continuation:dropped` says why no
   * turn ran for it.
   *
   * An outcome that leaves the execution paused (it paused again on its next
   * gated call) settles nothing, so it does not continue: a reply written
   * for it would be the latest message by the time the real outcome
   * arrives, and that outcome's continuation would have nothing to answer.
   */
  private async _applyExecutionOutcome(
    executionId: string,
    output: unknown,
    options?: RejectExecutionOptions
  ): Promise<boolean> {
    const toolCallId = await this._findExecutionToolCallDurably(
      executionId,
      true
    );
    if (!toolCallId) {
      // Already resolved in place (e.g. approved from another tab)? Then the
      // transcript has the outcome and nothing more is needed.
      if ((await this._findExecutionToolCallDurably(executionId)) != null) {
        return false;
      }
    }
    const apply = async (): Promise<ToolInteractionOutcome> => {
      if (toolCallId) {
        // Recorded before the outcome is written, so a restart before either
        // write lands still applies both before the next inference.
        await this._rememberResolvedPause(toolCallId, { executionId, output });
        const outcome = await this._applyToolUpdateToMessages(
          pausedExecutionUpdate(toolCallId, executionId, output)
        );
        if (isPausedToolPart({ state: "output-available", output })) {
          // The execution paused again on its next gated call. The call is
          // not settled: it still waits on an approval, as the text after
          // it says. There is nothing new for the model to answer, so no
          // continuation runs until the approval that settles it.
          await this._forgetResolvedPause(toolCallId);
          return { status: "unchanged" };
        }
        await this._dropGenerationAfterResolvedPause(toolCallId);
        return outcome;
      }
      let summary: string;
      try {
        summary = JSON.stringify(output)?.slice(0, 4_000) ?? String(output);
      } catch {
        summary = String(output);
      }
      const outcomeSource = executionId.startsWith(ACTION_PAUSE_ID_PREFIX)
        ? "durable action"
        : "execute tool";
      const note = await this._appendMessageToHistory({
        id: `${EXECUTION_OUTCOME_MESSAGE_PREFIX}${executionId}-${crypto.randomUUID()}`,
        role: "system",
        parts: [
          {
            type: "text",
            text:
              `[${outcomeSource}] The paused execution "${executionId}" was ` +
              `resolved, but its tool call is no longer in the transcript ` +
              `(it may have been compacted). Outcome: ${summary}`
          }
        ]
      } as UIMessage);
      return { status: "changed", messageId: note.id };
    };
    const autoContinue = options?.autoContinue !== false;
    // Continue on the approving connection when there is one (WS callable),
    // else any open connection (DO-stub approval with clients attached). When
    // NO connection is open — an approval arriving via RPC from a dashboard,
    // webhook, or voice backend — fall back to a connection-independent
    // continuation so the model still advances and the result isn't stranded.
    let target = getCurrentAgent().connection;
    if (!target) {
      for (const open of this.getConnections()) {
        target = open;
        break;
      }
    }
    const connection = target;
    if (connection || !autoContinue) {
      // Without `autoContinue` this re-arms the barrier, so a sibling that
      // already opted in fires once the batch is whole.
      await this._turns.applyInteraction(
        apply,
        autoContinue,
        () => this._continuationSpec(connection as Connection),
        (run) => this._enqueueInteractionOutcome(run),
        connection?.id ?? null
      );
    } else {
      // Like a connection's: only an outcome that settled its call
      // continues, and not when a stop landed while it was applied.
      await this._turns.applyInteractionThen(
        apply,
        (targetMessageId) =>
          this._queueConnectionlessContinuation(targetMessageId),
        (run) => this._enqueueInteractionOutcome(run)
      );
    }
    if (
      !autoContinue &&
      toolCallId &&
      this._deferredResolvedPauses.has(toolCallId)
    ) {
      // No continuation will run the deferred drop, so apply it once the
      // parking turn has persisted its message.
      if (this._turns.liveReply?.accumulator) {
        this._flushResolvedPausesOnFinalize = true;
      } else {
        await this._enqueueInteractionApply(() =>
          this._flushDeferredResolvedPauses()
        );
      }
    }
    return true;
  }

  /**
   * Find the tool part carrying `executionId` in its output — in the in-flight
   * streaming accumulator first (an approval can land while a new turn
   * streams), then the in-memory transcript, newest message first. With
   * `pausedOnly`, only a still-paused output matches — used to locate the
   * part an approval outcome should replace. Without it, any settled output
   * matches — used to distinguish "already resolved elsewhere" from "the
   * part is gone from the transcript" (e.g. compacted away).
   */
  private _findExecutionToolCall(
    executionId: string,
    pausedOnly = false
  ): string | null {
    const streaming = this._turns.liveReply?.accumulator;
    if (streaming) {
      const found = executionToolCallIn(
        { role: "assistant", parts: streaming.parts } as unknown as UIMessage,
        executionId,
        pausedOnly
      );
      if (found) return found;
    }

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const found = executionToolCallIn(
        this.messages[i],
        executionId,
        pausedOnly
      );
      if (found) return found;
    }
    return null;
  }

  /**
   * {@link _findExecutionToolCall}, falling back to storage when the hydrated
   * window does not cover the whole transcript, so a long-lived pause is
   * still resolved in place.
   */
  private async _findExecutionToolCallDurably(
    executionId: string,
    pausedOnly = false
  ): Promise<string | null> {
    const found = this._findExecutionToolCall(executionId, pausedOnly);
    if (found || this._cacheCoversActivePath) return found;
    for await (const message of this.session.history({ newestFirst: true })) {
      const stored = executionToolCallIn(
        message as UIMessage,
        executionId,
        pausedOnly
      );
      if (stored) return stored;
    }
    return null;
  }

  /**
   * Text and reasoning the model wrote after a paused tool result were written
   * against the pending state ("once approved, ..."). Once the pause resolves
   * they contradict the result, so drop them before the continuation reads the
   * transcript. Tool, file, and other parts after the pause stay.
   *
   * While the turn that paused is still streaming, its accumulator owns the
   * message and appends deltas to the last text part, so parts cannot be
   * removed underneath it. The drop is deferred to the next inference, which
   * is queued behind that turn and runs after it persists.
   *
   * The resolved pause stays recorded (see `_rememberResolvedPause`) until
   * the drop has been applied.
   */
  private async _dropGenerationAfterResolvedPause(
    toolCallId: string
  ): Promise<void> {
    const streaming = this._turns.liveReply?.accumulator;
    if (
      streaming?.parts.some(
        (part) => "toolCallId" in part && part.toolCallId === toolCallId
      )
    ) {
      return;
    }
    const owner = await this._resolveToolCallOwner(toolCallId, undefined);
    const parts = owner
      ? dropGenerationAfterToolCall(owner.parts, toolCallId)
      : undefined;
    if (owner && parts && parts !== owner.parts) {
      const safe = await this._updateMessageInHistory({ ...owner, parts });
      this._patchCachedMessage(safe);
      this._broadcast({ type: MSG_MESSAGE_UPDATED, message: safe });
    }
    await this._forgetResolvedPause(toolCallId);
  }

  private _loadResolvedPauses(): Promise<void> {
    this._deferredResolvedPausesLoad ??= (async () => {
      const stored = await this.ctx.storage.get<
        Array<[string, ResolvedPauseOutcome]>
      >(DEFERRED_RESOLVED_PAUSES_KEY);
      for (const [toolCallId, outcome] of stored ?? []) {
        if (!this._deferredResolvedPauses.has(toolCallId)) {
          this._deferredResolvedPauses.set(toolCallId, outcome);
        }
      }
    })().catch((error: unknown) => {
      // Let the next caller retry instead of treating the key as empty.
      this._deferredResolvedPausesLoad = undefined;
      throw error;
    });
    return this._deferredResolvedPausesLoad;
  }

  private async _rememberResolvedPause(
    toolCallId: string,
    outcome: ResolvedPauseOutcome
  ): Promise<void> {
    await this._loadResolvedPauses();
    this._deferredResolvedPauses.set(toolCallId, outcome);
    await this.ctx.storage.put(DEFERRED_RESOLVED_PAUSES_KEY, [
      ...this._deferredResolvedPauses
    ]);
  }

  private async _forgetResolvedPause(toolCallId: string): Promise<void> {
    await this._loadResolvedPauses();
    if (!this._deferredResolvedPauses.delete(toolCallId)) return;
    if (this._deferredResolvedPauses.size === 0) {
      await this.ctx.storage.delete(DEFERRED_RESOLVED_PAUSES_KEY);
    } else {
      await this.ctx.storage.put(DEFERRED_RESOLVED_PAUSES_KEY, [
        ...this._deferredResolvedPauses
      ]);
    }
  }

  private async _flushDeferredResolvedPauses(): Promise<void> {
    await this._loadResolvedPauses();
    for (const [toolCallId, outcome] of [...this._deferredResolvedPauses]) {
      // Still paused: a restart landed before the outcome was written, and the
      // execution it resolved is already consumed, so write it now. The owner
      // is looked up in storage when the hydrated window does not hold it.
      const owner = await this._resolveToolCallOwner(toolCallId, undefined);
      if (owner && ownsPausedToolCall(owner, toolCallId)) {
        await this._applyToolUpdateToMessages(
          pausedExecutionUpdate(toolCallId, outcome.executionId, outcome.output)
        );
      }
      await this._dropGenerationAfterResolvedPause(toolCallId);
    }
  }

  /**
   * Apply a tool update to its part with the shared `applyToolPartUpdate`:
   * in the in-flight accumulator (a client result can arrive before the
   * end-of-stream persist) and in the stored owner (a partial stall recovery
   * persisted, or an earlier message a cross-message result targets). The
   * owner is resolved without reading the transcript; the live cache is
   * patched in place rather than re-synced, because a full re-read during a
   * streaming turn drops in-flight messages whose parent chain is not
   * persisted yet.
   */
  private async _applyToolUpdateToMessages(
    update: ToolPartUpdate
  ): Promise<ToolInteractionOutcome> {
    const streaming = this._turns.liveReply?.accumulator;
    return applyToolPartUpdate<UIMessage>(update, {
      inFlight: streaming
        ? {
            id: streaming.messageId,
            parts: streaming.parts as unknown as Array<Record<string, unknown>>,
            snapshot: () => streaming.toMessage(),
            // The reply may be being stored from a copy built before this.
            changed: () => this._turns.liveReply?.changed()
          }
        : null,
      storedOwner: (toolCallId, inFlightId) =>
        this._resolveToolCallOwner(toolCallId, inFlightId, update),
      write: async (message) => {
        const safe = await this._updateMessageInHistory(message);
        this._patchCachedMessage(safe);
        return safe;
      },
      broadcast: (message) =>
        this._broadcast({ type: MSG_MESSAGE_UPDATED, message })
    });
  }

  /**
   * The persisted message that owns `toolCallId`, read as one row — or
   * `null` when no persisted row owns it.
   *
   * Lookup order, cheapest first:
   *
   * 1. `liveMessageId`, when the in-flight accumulator owns the call. A row
   *    under that id exists only when stall recovery persisted a partial
   *    mid-stream. When it does not, the call is not on its own row — but a
   *    provider can replay a prior tool round-trip into a fresh continuation
   *    accumulator (#1404), so the persisted owner may still be an earlier
   *    message; the cache is checked for that before concluding there is
   *    nothing durable to update. Storage is never walked for a call the
   *    live turn owns: every row it could target is on the cached path.
   * 2. The live cache, for the id only. Whatever names the row, the returned
   *    message is always the STORED form: the apply must compare against
   *    what storage holds, and the cache may be patched ahead of it.
   * 3. Storage, newest first, stopping at the first owner. Reached only when
   *    the cache does not cover the active path (a windowed hydration, a
   *    boot whose hydration failed, or rows imported behind the cache): a
   *    cross-message result can target a row older than the window, and the
   *    path is read from the leaf so a recent hit costs the rows it passed,
   *    not the transcript.
   *
   * This is what keeps a long turn's tool updates independent of transcript
   * length: the previous shape re-read the whole path per update.
   */
  private async _resolveToolCallOwner(
    toolCallId: string,
    liveMessageId: string | undefined,
    update?: ToolPartUpdate
  ): Promise<UIMessage | null> {
    const owns = (message: UIMessage): boolean =>
      message.parts.some(
        (part) => (part as { toolCallId?: unknown }).toolCallId === toolCallId
      );
    // A provider can reuse a tool-call id across replies: for an update that
    // names its approval, the newest message whose part it matches is the
    // owner, as in `@cloudflare/ai-chat`; otherwise the newest holder.
    // Only an update that names its approval: an id-less decision repeated
    // after it was stored must not land on an older request.
    const byMatch = update?.approvalId !== undefined;
    const matches = (message: UIMessage): boolean =>
      owns(message) &&
      (!byMatch ||
        applyToolUpdate(
          message.parts as unknown as Array<Record<string, unknown>>,
          update
        ) !== null);
    const stored = async (id: string): Promise<UIMessage | null> => {
      const row = (await this.session.getMessage(id)) as UIMessage | null;
      return row && owns(row) ? row : null;
    };
    const cachedOwnerId = (): string | null => {
      for (let i = this._cachedMessages.length - 1; byMatch && i >= 0; i--) {
        if (matches(this._cachedMessages[i])) {
          return this._cachedMessages[i].id;
        }
      }
      for (let i = this._cachedMessages.length - 1; i >= 0; i--) {
        if (owns(this._cachedMessages[i])) return this._cachedMessages[i].id;
      }
      return null;
    };

    if (liveMessageId !== undefined) {
      const live = await stored(liveMessageId);
      if (live) return live;
      const cachedId = cachedOwnerId();
      return cachedId === null ? null : stored(cachedId);
    }
    const cachedId = cachedOwnerId();
    if (cachedId !== null) return stored(cachedId);
    if (this._cacheCoversActivePath) return null;
    let newestHolder: UIMessage | null = null;
    for await (const message of this.session.history({ newestFirst: true })) {
      if (matches(message as UIMessage)) return message as UIMessage;
      if (!newestHolder && owns(message as UIMessage)) {
        newestHolder = message as UIMessage;
      }
    }
    return newestHolder;
  }

  // ── Stability + pending interactions ─────────────────────────────

  /**
   * `true` when the chat is waiting on a client: a tool call a client still
   * has to answer, or an approval it still has to give.
   *
   * Every unanswered call in the stored transcript counts, whatever its tool.
   * A reply is stored unanswered only when its stream finished on that call,
   * which is what a client tool does; a reply that was cut off has its dead
   * calls settled before it is stored. In the reply streaming now, only a
   * tool the client sent a schema for counts, because a server tool sits at
   * `input-available` while it runs. The same check as `@cloudflare/ai-chat`.
   */
  protected hasPendingInteraction(): boolean {
    return this._turns.hasPendingInteraction();
  }

  protected async waitUntilStable(options?: {
    timeout?: number;
  }): Promise<boolean> {
    return this._turns.waitUntilStable({
      timeout: options?.timeout,
      hasPendingInteraction: () => this.hasPendingInteraction()
    });
  }

  /**
   * Every tool a client may answer: the tools the client sent a schema for,
   * and the tools the server declares with no `execute` (an app answers
   * those from the client, without ever sending their schema). A call for
   * any other tool was the server's to run. Unanswered in a stored reply, it
   * is dead: an older version stored cut-off replies as they were.
   */
  private _clientAnswerableToolNames(): Set<string> {
    // The client tools from the last request, which the SPA answers by
    // replaying a `tool-result` after a restart.
    const names = this._requestContext.clientToolNames();
    for (const name of this._unexecutedToolNames()) names.add(name);
    return names;
  }

  /**
   * Store which of a turn's tools the server does not run, so the answer is
   * there after a restart, before any turn has assembled its tools again.
   */
  private _recordUnexecutedTools(tools: ToolSet): void {
    const names = unexecutedToolNames(tools);
    this._unexecutedTools = names;
    // `_configSet` skips the write when the value has not changed.
    this._cfConfig.set("unexecutedTools", JSON.stringify(names));
  }

  /** Read once per isolate: `hasPendingInteraction()` is polled. */
  private _unexecutedTools: string[] | undefined;

  /**
   * The tools the last turn had that the server does not run. Before the
   * first turn on this version there is no record, so read `getTools()`:
   * the app's own tools are where a tool without `execute` is declared.
   */
  private _unexecutedToolNames(): string[] {
    if (this._unexecutedTools) return this._unexecutedTools;
    const stored = this._cfConfig.get("unexecutedTools");
    if (stored !== undefined) {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          this._unexecutedTools = parsed.filter(
            (name): name is string => typeof name === "string"
          );
          return this._unexecutedTools;
        }
      } catch {
        // Fall through to the app's tools.
      }
    }
    try {
      this._unexecutedTools = unexecutedToolNames(this.getTools());
    } catch {
      // `getTools()` can need turn-time context. Without it, only the
      // client's own tools are known to be a client's.
      this._unexecutedTools = [];
    }
    return this._unexecutedTools;
  }

  // ── Chat recovery via fibers ───────────────────────────────────

  private _resolveChatRecoveryConfig(): ResolvedChatRecoveryConfig {
    // Delegates to the shared incident engine (agents/chat) so Think and
    // AIChatAgent resolve recovery config identically. See
    // design/rfc-chat-recovery-foundation.md.
    return resolveChatRecoveryConfig(this.chatRecovery);
  }

  /**
   * Monotonic forward-progress signal for recovery budget resets.
   *
   * This used to count assistant messages in `this.messages`, but that is
   * recomputed from the live, mutable transcript. Compaction collapses older
   * assistant messages into a summary, lowering the count — so a turn that had
   * genuinely advanced could read as "no progress" between attempts and exhaust
   * its budget prematurely (#1628). It then became a KV counter bumped per
   * credited chunk. It is now derived from the stream log the chunks were
   * already flushed to (`ResumableStream.progressMarker`): the log only grows
   * when new content lands durably, a reconnect replay or a recovery
   * re-persist reads it without appending (#1637), and compaction rewrites
   * the transcript, not the log. Nothing is written per chunk.
   *
   * The pre-derivation KV counter is folded in once per isolate, so a marker
   * an in-flight incident already recorded is never read lower after the
   * upgrade.
   */
  private readonly _chatRecoveryProgressMarker = chatRecoveryProgressReader(
    this.ctx.storage,
    () => this._resumableStream
  );

  /** Per-isolate N9 throttle gate (shared `agents/chat` helper); reset per
   *  isolate so the first forwarded chunk after a restart always credits. */
  private _agentToolStreamProgress = new AgentToolStreamProgressThrottle();

  /**
   * N9: forwarding a sub-agent's chunks IS forward progress for this parent
   * turn, so credit the parent's recovery progress marker — otherwise a parent
   * whose turn merely `await`s a child banks no progress of its own and its
   * no-progress window exhausts while the child is healthily streaming. The
   * child's output goes to clients, not to this object's stream log, so the
   * derived marker cannot see it; this is the one explicit credit left. Only
   * invoked after a child actually produced output (see
   * `_forwardAgentToolStream`), so a silent child still lets the parent exhaust.
   * Throttled (and reset per isolate) so we never write storage per token.
   */
  protected override async _onAgentToolStreamProgress(): Promise<void> {
    if (this._agentToolStreamProgress.shouldCredit(Date.now())) {
      this._resumableStream.creditProgress();
    }
  }

  /**
   * Lazily-built shared recovery engine. The adapter arrows capture `this`, so a
   * single cached instance is correct across calls.
   */
  private _chatRecoveryEngineInstance?: ChatRecoveryEngine;
  private _chatRecoveryEngine(): ChatRecoveryEngine {
    return (this._chatRecoveryEngineInstance ??= new ChatRecoveryEngine({
      resolveConfig: () => this._resolveChatRecoveryConfig(),
      ...chatRecoveryStorageAdapter(this.ctx.storage),
      turns: {
        label: "[Think]",
        beginRecoveryAttempt: (rootRequestId) =>
          this._turns.beginRecoveryAttempt(rootRequestId),
        waitUntilStable: (timeout) => this.waitUntilStable({ timeout }),
        recordTerminalError: (requestId, errorText) =>
          this._recordTerminalChatStatus("error", requestId, errorText),
        endSkippedRequest: (requestId) =>
          this._frames.endUnstarted(null, requestId, "skipped"),
        reconcileAgentToolChildRuns: () => this._agentToolRuns.reconcileOwn(),
        trackAlarmWork: (turn) => this.lifecycle.trackAlarmWork(turn),
        attemptScope: new AsyncLocalStorage<ChatRecoveryAttemptScope>(),
        latestMessage: () => this.messages.at(-1),
        originMessageIdsScope: this._chatRecoveryOriginIdsScope,
        // SAFETY: the recovery engine is the sole producer of each
        // callback's payload and the Task persists it verbatim, so the
        // callback name selects the matching host input type.
        attempts: {
          _chatRecoveryContinue: (data, onTurnStarted) =>
            this._chatRecoveryContinueDetached(
              data as ChatRecoveryContinueData | undefined,
              onTurnStarted
            ),
          _chatRecoveryRetry: (data, onTurnStarted) =>
            this._chatRecoveryRetryDetached(
              data as ChatRecoveryRetryData | undefined,
              onTurnStarted
            )
        }
      },
      // Hibernation ordering guard. The budget decision consults
      // `hasPendingInteraction()` -> `_requestContext.clientToolNames()` ->
      // `_lastClientTools` to keep a HITL turn (parked on a client-tool
      // `input-available` orphan) budget-free. On a fresh wake the base Agent
      // runs the boot-recovery path (`_handleInternalFiberRecovery`) BEFORE
      // onStart's `_restoreClientTools()`, so without this the in-memory cache
      // is empty and such a turn is misread as "stuck" and wrongly sealed (the
      // slow-human + deploy-churn case). Re-hydrate from the durable
      // `think_config` store — its own table, no Session init required, so the
      // read is safe this early; the guard keeps it idempotent with the later
      // onStart restore and a no-op on the live-isolate stall path where the
      // tools are already loaded. The engine invokes this BEFORE it reads
      // `isAwaitingClientInteraction()`.
      ensureInteractionStateLoaded: () => {
        if (this._lastClientTools === undefined) {
          this._requestContext.restore("lastClientTools");
        }
      },
      readProgress: () => this._chatRecoveryProgressMarker(),
      // A turn parked on a pending CLIENT interaction is waiting on the human,
      // not stuck, so the engine keeps it budget-free. SERVER-tool orphans are
      // excluded by `hasPendingInteraction` and still recover normally.
      isAwaitingClientInteraction: () => this.hasPendingInteraction(),
      turnRecovered: (requestIds) => {
        for (const requestId of requestIds) {
          this._turns.turnAccepted(requestId);
        }
      },
      recoverySettled: () => {
        this._resumeAdmissions();
        if (this._submissionsBehindRecovery.size > 0) {
          void this.keepAliveWhile(() =>
            this._queuePendingSubmissionRuns()
          ).catch((error) =>
            console.error("[Think] failed to queue submissions:", error)
          );
        }
      },
      emitRecoveryEvent: (event) => {
        this._emit(event.type, {
          incidentId: event.incidentId,
          requestId: event.requestId,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          recoveryKind: event.recoveryKind,
          ...(event.reason ? { reason: event.reason } : {})
        });
        if (event.type === "chat:recovery:completed") {
          this._settleMessengerRecovery(event.incidentId, "completed");
        } else if (
          event.type === "chat:recovery:skipped" ||
          event.type === "chat:recovery:failed"
        ) {
          this._settleMessengerRecovery(event.incidentId, "interrupted");
        }
      },
      scheduleRecovery: (callback, data, reason, delaySeconds, dedupeKey) =>
        this._enqueueChatRecovery(
          callback,
          data,
          reason,
          delaySeconds,
          dedupeKey
        ),
      setRecovering: (active, requestId) =>
        this._setChatRecovering(active, requestId),
      onShouldKeepRecoveringError: (error) =>
        console.error(
          "[Think] chatRecovery shouldKeepRecovering hook threw",
          error
        ),
      exhaustChatRecovery: (
        incident,
        config,
        partial,
        streamId,
        createdAt,
        originMessageIds
      ) =>
        this._exhaustChatRecovery(
          incident,
          config,
          partial,
          streamId,
          createdAt,
          originMessageIds
        ),
      resolveRecoveryStream: (requestId) =>
        this._resolveThinkRecoveryStream(requestId),
      getPartialStreamText: (streamId) => this._getPartialStreamText(streamId),
      onGiveUpBookkeepingError: (phase, error) =>
        console.error(
          phase === "read"
            ? "[Think] failed to read recovery incident during give-up; synthesizing"
            : "[Think] failed to persist sealed recovery incident during give-up",
          error
        )
    } satisfies ChatRecoveryAdapter));
  }

  private async _exhaustChatRecovery(
    incident: ChatRecoveryIncident,
    config: ResolvedChatRecoveryConfig,
    // `parts` is the engine's vocabulary-agnostic `unknown[]`; Think owns the AI
    // SDK `UIMessage` vocabulary, so it re-asserts `MessagePart[]` at the
    // user-facing exhausted-context edge below.
    partial: { text: string; parts: unknown[] },
    streamId: string,
    createdAt: number,
    originMessageIds?: string[]
  ): Promise<void> {
    // Build + notification (event + onExhausted-swallow) and the
    // notify-before-terminalize invariant live in the engine helper; the
    // broadcast/terminal ordering inside `terminalize` is Think's own
    // (broadcast-first; see the note below). See
    // design/rfc-chat-recovery-foundation.md.
    await runChatRecoveryExhaustion(
      {
        incident,
        config,
        partialText: partial.text,
        partialParts: partial.parts as MessagePart[],
        streamId,
        createdAt
      },
      {
        emit: (event) => {
          this._emit("chat:recovery:exhausted", event);
          this._settleMessengerRecovery(incident.incidentId, "interrupted");
        },
        onExhausted: config.onExhausted,
        onError: (error) =>
          console.error("[Think] chatRecovery onExhausted hook threw", error),
        terminalize: async (ctx) => {
          // Deliver the user-visible terminal banner BEFORE the bookkeeping
          // storage writes below. A `ctx.storage` write can reject mid-deploy
          // (the exact window recovery exhausts in), and if it threw before this
          // broadcast the user would be left staring at a half-finished message
          // with no terminal resolution. The broadcast itself touches no
          // storage, so ordering it first makes the banner resilient to a
          // failing `_recordTerminalChatStatus` / `_markRecoveredSubmissionInterrupted`.
          // `@cloudflare/ai-chat` terminalizes broadcast-first for the same
          // reason; only the set of durable writes below differs (Think also
          // writes a submission row).
          const messageIds =
            this._frames.originIds(ctx.requestId) ?? originMessageIds;
          this._frames.broadcast({
            type: MSG_CHAT_RESPONSE,
            id: ctx.requestId,
            body: ctx.terminalMessage,
            done: true,
            error: true,
            ...(messageIds ? { messageIds } : {})
          });
          // Write the durable terminal record (#1645) FIRST among the storage
          // writes: it's the record a disconnected client replays on reconnect,
          // so it must not be skipped if the (independent) submission-row write
          // below throws.
          await this._recordTerminalChatStatus(
            "interrupted",
            ctx.requestId,
            ctx.terminalMessage,
            messageIds
          );
          // The recovery root locates the stable submission identity even
          // after request_id has been rebound to an accepted successor.
          await this._markRecoveredSubmissionInterrupted(
            ctx.recoveryRootRequestId ?? ctx.requestId,
            ctx.terminalMessage
          );
        }
      }
    );
    // The exhausted record is retained for inspection and reclaimed later by
    // the TTL sweep; only successful (completed) incidents are deleted eagerly.
  }

  /**
   * Route a live stream interruption (the stall watchdog fired, or the
   * provider failed with a transient error) into the bounded recovery a
   * deploy or eviction interruption uses (#1626). The shared engine owns the
   * sequence. This supplies what is `Think`'s: the partial is stored through
   * `persistPartial`, a durable submission the turn belongs to is handed to
   * the recovery, and a declined continuation is reported on the submission
   * and to the client.
   *
   * For `"exhausted"` and `"declined"` the terminal message is already
   * delivered, so the caller must not run its generic terminal path.
   */
  private _routeStreamInterruption(
    input: StreamInterruptionRoute
  ): Promise<StreamInterruptionOutcome> {
    const recoveryRootRequestId =
      this._activeChatRecoveryRootRequestId ?? input.requestId;
    const liveTurn = this._liveChatRecoveryTurns.get(input.requestId);
    // The turn's own tools and body. A pinned turn never wrote them to the
    // stored context.
    const turnContext = this._chatTurnFibers.requestContext(
      input.requestId
    ) ?? {
      lastBody: this._lastBody,
      lastClientTools: this._lastClientTools
    };
    // If a durable submission is running for this turn, the recovery must
    // complete it, or the submission hangs.
    const recoveredRequestId = () =>
      this._readRunningSubmissionForRecovery(recoveryRootRequestId)
        ?.submission_id;
    return this._chatRecoveryEngine().routeStreamInterruption({
      requestId: input.requestId,
      streamId: input.streamId,
      partialParts: input.partialParts,
      backoff: input.backoff,
      error: input.error,
      retryAfterSeconds: input.retryAfterSeconds,
      latestUserMessageId:
        [...this.messages].reverse().find((m) => m.role === "user")?.id ?? null,
      originMessageIds: this._frames.originIds(input.requestId),
      // A stall before the first chunk leaves the user's message as the
      // leaf (#1941). A regeneration retries the message it branches from.
      retryTargetUserId: async () =>
        input.branchParentId ?? (await this._latestUserLeafId()),
      onChatRecovery: (context) =>
        this.onChatRecovery({
          incidentId: context.incidentId,
          recoveryRootRequestId: context.recoveryRootRequestId,
          attempt: context.attempt,
          maxAttempts: context.maxAttempts,
          recoveryKind: context.recoveryKind,
          streamId: context.streamId,
          requestId: context.requestId,
          partialText: context.partialText,
          partialParts: context.partialParts,
          recoveryData: liveTurn?.recoveryData ?? null,
          messages: [...this.messages],
          ...turnContext,
          createdAt: liveTurn?.createdAt ?? context.firstSeenAt
        }),
      resolvePartial: async (keep) => {
        if (keep) return input.persistPartial();
        input.onPartialDropped();
        return undefined;
      },
      requestContext: () => turnContext,
      // The turn then ends as its stream error, which the caller sends.
      onDeclined: (errorText) =>
        this._markRecoveredSubmissionInterrupted(
          recoveryRootRequestId,
          errorText
        ),
      beforeSchedule: (incidentId, partialText) =>
        this._claimMessengerRecoveryDelivery(
          input.requestId,
          incidentId,
          partialText
        ),
      scheduleData: async (kind) => {
        const submissionId = recoveredRequestId();
        return {
          ...(kind === "retry" &&
            input.branchParentId !== undefined && {
              regeneratedLeafId: (await this.session.getLatestLeaf())?.id
            }),
          ...(submissionId ? { recoveredRequestId: submissionId } : {})
        };
      },
      afterSchedule: (chained) =>
        this._claimSubmissionForRecovery(
          recoveredRequestId(),
          chained ? "chained_retry" : undefined
        )
    });
  }

  /**
   * Submissions whose turn scheduled recovery: the recovery completes them,
   * so the submission runner must leave them `running`.
   */
  private _recoveryOwnedSubmissions = new Set<string>();
  /**
   * Submissions that were pending when this isolate started. They were
   * accepted behind a turn the reset may have cut off, so they run after
   * that turn's recovery, as a client request queued behind it does
   * (`ChatTurns.resumeAdmissions`).
   */
  private _submissionsBehindRecovery = new Set<string>();

  private _claimSubmissionForRecovery(
    submissionId: string | undefined,
    reason: "chained_retry" | undefined
  ): void {
    // Inside a recovery attempt the callback already owns the submission.
    if (submissionId && reason === undefined) {
      this._recoveryOwnedSubmissions.add(submissionId);
    }
  }

  private async _latestUserLeafId(): Promise<string | null> {
    const leaf = await this.session.getLatestLeaf();
    return leaf?.role === "user" ? leaf.id : null;
  }

  /**
   * A fiber left by a dead isolate. Messenger/workflow reply fibers
   * (`think:messenger-reply`) are not chat turns: the messenger runtime owns
   * their recovery, and it is asked first so such a fiber is never misread as
   * an orphaned chat turn. A chat turn's fiber row an older version left in
   * the fiber ledger is recovered like a replayed chat-turn Task run. Every
   * other fiber is the app's.
   */
  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    if (await this._messengerRuntime?.handleFiberRecovery(ctx)) return true;
    const prefix = (this.constructor as typeof Think).CHAT_FIBER_NAME + ":";
    if (!ctx.name.startsWith(prefix)) return false;
    await this._recoverChatTurn({
      requestId: ctx.name.slice(prefix.length),
      persisted: ctx.snapshot,
      createdAt: ctx.createdAt
    });
    return true;
  }

  /**
   * Recover a chat turn whose isolate died before it finished. The lifecycle
   * (stream/partial → classify → begin-incident → exhausted-branch →
   * onChatRecovery → persist → complete → dispatch → catch→failed) lives in the
   * shared ChatRecoveryEngine; this binds the divergent organs as wake hooks,
   * symmetric with `AIChatAgent`. `Think` tracks terminal stream status and a
   * durable submission layer + session leaf, so its dispatch owns the
   * terminal-skip / submission-completion / interrupted-broadcast branches the
   * engine frame stays out of. See design/rfc-chat-recovery-foundation.md.
   *
   * @param turn - `persisted` is the snapshot envelope the turn stored.
   */
  private async _recoverChatTurn(turn: {
    requestId: string;
    persisted: unknown;
    createdAt: number;
  }): Promise<void> {
    if (await this._settlePersistedChatTurn(turn.requestId)) return;
    const { snapshot, user } = unwrapChatFiberSnapshot<"think-chat-turn">(
      "__cfThinkChatFiberSnapshot",
      turn.persisted,
      "think-chat-turn"
    );
    await this._chatRecoveryEngine().recoverInterruptedTurn(
      {
        requestId: turn.requestId,
        snapshot,
        recoveryData: user,
        createdAt: turn.createdAt
      },
      this._chatRecoveryWakeHooks()
    );
  }

  /**
   * A turn that owes its response hook and already persisted its message
   * finished: its stream rows may be gone with the cutover, so recovery would
   * otherwise re-run it. Fire the owed hook and settle the submission instead.
   */
  private async _settlePersistedChatTurn(requestId: string): Promise<boolean> {
    const hook = await this.ctx.storage.get<PendingResponseHook>(
      PENDING_RESPONSE_HOOK_PREFIX + requestId
    );
    if (!hook || !(await this.session.getMessage(hook.messageId))) {
      return false;
    }
    await this._replayPendingResponseHooks(requestId);
    await this._completeRecoveredSubmission(
      requestId,
      hook.status === "error" ? "error" : "completed",
      requestId,
      hook.error ?? null
    );
    return true;
  }

  private _chatRecoveryWakeHooks(): ChatFiberWakeHooks<ThinkRecoveryClassification> {
    return {
      classifyRecoveredTurn: (input) => this._classifyRecoveredThinkTurn(input),
      invokeOnChatRecovery: (input) =>
        this.onChatRecovery({
          incidentId: input.incident.incidentId,
          recoveryRootRequestId: input.recoveryRootRequestId,
          attempt: input.incident.attempt,
          maxAttempts: input.incident.maxAttempts,
          recoveryKind: input.recoveryKind,
          streamId: input.streamId,
          requestId: input.requestId,
          partialText: input.partial.text,
          // The engine seam is vocabulary-agnostic (`unknown[]`); Think owns the
          // AI SDK parts vocabulary, so re-assert it for the user-facing context.
          partialParts: input.partial.parts as MessagePart[],
          recoveryData: input.recoveryData,
          messages: [...this.messages],
          lastBody: input.snapshot?.lastBody ?? this._lastBody,
          lastClientTools:
            input.snapshot?.lastClientTools ?? this._lastClientTools,
          createdAt: input.createdAt
        }),
      shouldPersistOrphanedPartial: (input) =>
        this._shouldPersistOrphanedPartial(input.streamId, {
          streamStillActive: input.streamStillActive,
          streamIsTerminal:
            input.streamStatus === "completed" ||
            input.streamStatus === "error",
          snapshot: input.snapshot
        }),
      persistOrphanedStream: (streamId) =>
        this._persistOrphanedStream(streamId),
      completeRecoveredStream: (streamId) =>
        this._replyStreams.complete(streamId),
      dispatchRecoveredTurn: (input) => this._dispatchRecoveredThinkTurn(input)
    };
  }

  /**
   * Resolve the orphaned stream + its terminal status for a recovered chat turn.
   * Drives BOTH the wake path (full result) and the give-up terminalization
   * (which reads only `.streamId`; the terminal banner still fires when
   * `streamId` is `""` — `_exhaustChatRecovery` does not require a stream).
   * Prefers the newest durable stream row keyed by the recovery-root request id;
   * falls back to the live active stream.
   */
  private _resolveThinkRecoveryStream(
    requestId: string
  ): ResolvedRecoveryStream {
    let streamId = "";
    let streamStatus: "streaming" | "completed" | "error" | undefined;
    if (requestId) {
      const info = this._resumableStream.latestStreamInfoForRequest(requestId);
      if (info) {
        streamId = info.id;
        // A stream that was closed with no producer left (a tab reconnected
        // and its resume closed it before this recovery ran) reads
        // `completed`, but the model never finished the reply. It is still
        // the cut-off stream recovery continues.
        streamStatus =
          info.cutOff && info.status === "completed"
            ? "streaming"
            : info.status;
      }
    }
    if (!streamId && this._resumableStream.hasActiveStream()) {
      streamId = this._resumableStream.activeStreamId ?? "";
      streamStatus = "streaming";
    }
    const streamStillActive = Boolean(
      streamId &&
      this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeStreamId === streamId
    );
    return { streamId, streamStillActive, streamStatus };
  }

  /**
   * Classify a recovered turn as `retry` or `continue`. A turn that left no
   * persisted partial re-runs its user message (`retryTargetUserId`), unless
   * the stream is already terminal — a terminal stream is never retried (it
   * completed), only its submission is reconciled in dispatch.
   *
   * The stream row is opened before inference, so an interrupted turn can
   * have a stream id and still nothing to continue from; what decides retry is
   * the absence of persisted content and a leaf that is still the turn's user
   * message. Mirrors `AIChatAgent`'s empty-partial new-turn rule (#1691): a
   * `continue` here would find no assistant message and skip the turn.
   */
  private async _classifyRecoveredThinkTurn(
    input: ClassifyRecoveredTurnInput
  ): Promise<{
    recoveryKind: ChatRecoveryKind;
    detail: ThinkRecoveryClassification;
  }> {
    const streamIsTerminal =
      input.streamStatus === "completed" || input.streamStatus === "error";
    const retryTargetUserId = await this._recoverablePreStreamUserId(
      input.snapshot,
      input.partial
    );
    const shouldRetryBase = retryTargetUserId !== null && !streamIsTerminal;
    const recoveryKind: ChatRecoveryKind = shouldRetryBase
      ? "retry"
      : "continue";
    return { recoveryKind, detail: { retryTargetUserId } };
  }

  /**
   * The retry/continue/skip decision for a recovered chat turn, run after the
   * partial is persisted and the stream completed. Owns `Think`'s substrate
   * behavior the engine frame stays out of: a terminal stream reconciles the
   * durable submission (and is never retried/continued), and a `continue: false`
   * abandonment marks the submission interrupted + records a terminal status +
   * broadcasts so a reconnecting client is not frozen.
   */
  private async _dispatchRecoveredThinkTurn(
    input: DispatchRecoveredTurnInput<ThinkRecoveryClassification>
  ): Promise<void> {
    const {
      incident,
      options,
      snapshot,
      requestId,
      recoveryRootRequestId,
      streamStatus
    } = input;
    const { retryTargetUserId } = input.detail;
    const originIds =
      this._frames.originIds(requestId) ?? snapshot?.originMessageIds;
    const streamIsTerminal =
      streamStatus === "completed" || streamStatus === "error";

    const shouldRetry =
      retryTargetUserId !== null &&
      options.continue !== false &&
      !streamIsTerminal;
    const lastLeaf = shouldRetry ? null : await this._recoveryLeaf();
    const targetId =
      lastLeaf?.role === "assistant" && !streamIsTerminal
        ? lastLeaf.id
        : undefined;
    const canContinue =
      !shouldRetry && options.continue !== false && !streamIsTerminal;
    // Keep recovery payloads linked to the stable submission/root identity;
    // request_id now follows the accepted successor for startup evidence.
    // The recovery lookup accepts either identity, including released payloads.
    const recoveredSubmission = this._readRunningSubmissionForRecovery(
      recoveryRootRequestId
    );

    if (streamIsTerminal && recoveredSubmission) {
      await this._completeRecoveredSubmission(
        recoveryRootRequestId,
        streamStatus === "completed" ? "completed" : "error",
        requestId,
        streamStatus === "completed"
          ? null
          : "Recovered chat stream had already errored."
      );
    }

    const recoveredRequestId =
      (canContinue || shouldRetry) && recoveredSubmission
        ? recoveredSubmission.submission_id
        : undefined;

    if (shouldRetry || canContinue) {
      await this._chatRecoveryEngine().scheduleRecoveredTurn({
        incident,
        recoveryKind: input.recoveryKind,
        recoveryRootRequestId,
        retryUserId: shouldRetry ? retryTargetUserId : null,
        targetAssistantId: targetId,
        requestContext: snapshot,
        originMessageIds: originIds,
        extra: {
          ...(shouldRetry &&
            regenerationParentOf(snapshot) !== undefined &&
            snapshot?.latestMessageId && {
              regeneratedLeafId: snapshot.latestMessageId
            }),
          // The payload keeps the stable submission identity. `request_id`
          // follows the accepted successor, and the recovery lookup accepts
          // either.
          ...(recoveredRequestId ? { recoveredRequestId } : {})
        }
      });
    } else if (options.continue === false && !streamIsTerminal) {
      await this._chatRecoveryEngine().updateIncident(
        incident.incidentId,
        "skipped",
        "continue_disabled"
      );
      await this._declineRecoveredTurn(recoveryRootRequestId, requestId);
    } else {
      await this._chatRecoveryEngine().updateIncident(
        incident.incidentId,
        "skipped",
        streamIsTerminal ? "stream_terminal" : "not_recoverable"
      );
    }
  }

  /**
   * The app declined to continue an interrupted turn (`continue: false`).
   * Mark its submission interrupted, so it does not wait on a turn nobody
   * will finish, and tell the client. The recovery root still locates the
   * submission after `request_id` has moved to a successor turn.
   */
  private async _declineRecoveredTurn(
    recoveryRootRequestId: string,
    requestId: string
  ): Promise<void> {
    const declinedMessage =
      "Submission was interrupted and automatic continuation was declined.";
    await this._markRecoveredSubmissionInterrupted(
      recoveryRootRequestId,
      declinedMessage
    );
    await this._recordTerminalChatStatus(
      "interrupted",
      requestId,
      declinedMessage
    );
    this._frames.broadcast({
      type: MSG_CHAT_RESPONSE,
      id: requestId,
      body: declinedMessage,
      done: true,
      error: true
    });
  }

  private async _recoverablePreStreamUserId(
    snapshot: ChatFiberSnapshot | null,
    partial: { text: string; parts: unknown[] }
  ): Promise<string | null> {
    // A partial that holds only the internal final-answer tool, or only the
    // reasoning the model was cut off in, persists nothing. The user message
    // stays the leaf and there is nothing to continue.
    if (
      !snapshot ||
      snapshot.continuation ||
      !snapshot.latestUserMessageId ||
      partial.text ||
      (partial.parts.length > 0 &&
        this._strippedForPersist(
          stripTrailingReasoning({
            id: "",
            role: "assistant",
            parts: partial.parts as UIMessage["parts"]
          })
        ) !== null)
    ) {
      return null;
    }

    const lastLeaf = await this._recoveryLeaf();
    // A regeneration branches beside the response it replaces, so that
    // response, not the user message, is still the leaf.
    const branchParentId = regenerationParentOf(snapshot);
    if (branchParentId !== undefined) {
      return lastLeaf !== null && lastLeaf.id === snapshot.latestMessageId
        ? branchParentId
        : null;
    }
    return lastLeaf?.role === "user" &&
      lastLeaf.id === snapshot.latestUserMessageId
      ? snapshot.latestUserMessageId
      : null;
  }

  private async _hasPersistedRecoveredAssistant(
    snapshot: ChatFiberSnapshot | null
  ): Promise<boolean> {
    const lastLeaf = await this._recoveryLeaf();
    return (
      lastLeaf?.role === "assistant" &&
      lastLeaf.id !== snapshot?.latestMessageId
    );
  }

  /**
   * Whether the orphaned stream's partial should be materialized into an
   * assistant message: there is a stream, and it is either still active or
   * terminal-but-not-yet-persisted. Shared by the normal recovery path AND the
   * exhaustion path so neither discards settled work nor duplicates a partial
   * an earlier attempt already saved.
   */
  private async _shouldPersistOrphanedPartial(
    streamId: string,
    opts: {
      streamStillActive: boolean;
      streamIsTerminal: boolean;
      snapshot: ChatFiberSnapshot | null;
    }
  ): Promise<boolean> {
    if (!streamId) return false;
    const alreadyPersisted =
      opts.streamIsTerminal &&
      (await this._hasPersistedRecoveredAssistant(opts.snapshot));
    return (
      opts.streamStillActive || (opts.streamIsTerminal && !alreadyPersisted)
    );
  }

  /**
   * Terminalize a recovery turn that is giving up — whether because the
   * stable-state-timeout retry budget drained, or because the recovery
   * continuation threw a non-recoverable error — by routing through the SAME
   * `_exhaustChatRecovery` path as deploy-recovery and stall exhaustion
   * (#1626/#1631). It fires `onExhausted`, emits `chat:recovery:exhausted`,
   * marks the durable submission interrupted, records the terminal chat status,
   * and delivers the configured `terminalMessage`. `reason` carries the cause
   * (`stable_timeout` for a budget give-up, `recovery_error` for a thrown
   * error) through to `onExhausted` / `chat:recovery:exhausted`.
   *
   * This replaces the older give-up that only set the incident to `failed` and
   * completed the recovered submission as `error`, which bypassed
   * `_exhaustChatRecovery` entirely — so an app relying on `onExhausted` for the
   * terminal banner regressed to an eternal spinner when recovery gave up under
   * extreme churn. The error path matters just as much: a non-transient throw
   * in a recovery callback is SWALLOWED by the driving Task attempt (or the
   * routed one-shot schedule row) — only a platform transient is re-thrown to
   * preserve it — so without routing it here the run/row settles with no
   * terminal UX at all — the half-finished message wedges silently. Shared by
   * `_chatRecoveryRetry` and `_chatRecoveryContinue`.
   *
   * Exactly-once terminalization is defended by two independent guards:
   *  1. The `stored?.status === "exhausted"` re-entry guard below — once an
   *     incident is sealed, a duplicate stale alarm (or retried callback)
   *     returns before re-firing. The seal is persisted only AFTER the
   *     terminal writes in `_exhaustChatRecovery` succeed (see the ordering
   *     note at the call below), so a give-up interrupted by a platform
   *     transient re-runs in full instead of being half-sealed.
   *  2. The durable-submission paths additionally short-circuit earlier at the
   *     `submission_not_running` check (the submission is already `error` after
   *     the first give-up). This is the ONLY guard `@cloudflare/ai-chat` lacks
   *     (no submission layer), so guard #1 carries it there.
   *
   * Residual at-least-once edges, all deliberately accepted as "deliver a
   * second banner" ≫ "silently drop the turn":
   *  • No `incidentId` at all in the payload (only reachable via a direct/test
   *    invocation — every production recovery enqueue carries one): the
   *    synthesized incident can't be persisted (no key), so guard #1 can't
   *    arm.
   *  • The record is swept AGAIN between two alarms (guard #1 re-persists on the
   *    first, so this needs a second independent sweep) — vanishingly unlikely.
   *  • A platform transient interrupts `_exhaustChatRecovery` after the banner
   *    broadcast — the deferred re-run re-fires `onExhausted` + the banner
   *    (the terminal writes themselves are idempotent).
   */
  /**
   * Host memory-limit policy hook (#1825), dispatched structurally by
   * Lifecycle's circuit breaker — protected because it is framework
   * machinery, not part of the public Think API. Tasks applies the breaker to
   * root recovery runs; the routed dynamic-agent fallback applies it to
   * `recoveryLoop` schedule rows (see `RecoveryLoopScheduleOptions`). At the
   * strike budget this hook seals active incidents via
   * `ChatRecoveryEngine.sealMemoryLimitedRecovery`.
   */
  protected async onAlarmMemoryLimit(context: { readonly sealed: boolean }) {
    if (!context.sealed) return;
    await this._chatRecoveryEngine().sealMemoryLimitedRecovery();
  }

  /**
   * Keep the recovery callback as owner until a chat Task or facet fiber is durably
   * accepted. At acceptance, move the running submission to the successor's
   * request identity before signaling handoff. If an override never starts a
   * durable successor, the signal stays inert and the callback owns the work
   * until the override returns.
   */
  private async _runRecoveredTurnAfterAcceptance<T>(
    recoveredSubmission: ThinkSubmissionRow | null,
    onTurnStarted: (() => void) | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    let signaled = false;
    const onAccepted = (successorRequestId: string): void => {
      if (signaled) return;
      signaled = true;
      if (recoveredSubmission) {
        this.sql`
          UPDATE cf_think_submissions
          SET request_id = ${successorRequestId}
          WHERE submission_id = ${recoveredSubmission.submission_id}
            AND status = 'running'
        `;
      }
      onTurnStarted?.();
    };
    const workflowPrompt = recoveredSubmission
      ? this._readWorkflowPromptContext(
          this._parseJsonObject(recoveredSubmission.metadata_json)
        )
      : null;
    return recoveredTurnAcceptanceContext.run(
      { agent: this, onAccepted, workflowPrompt: workflowPrompt ?? undefined },
      run
    );
  }

  /**
   * The workflow prompt of the submission a recovery turn is completing. A
   * structured prompt must re-arm its final-answer tool on the recovered turn,
   * or the turn can never produce the output the workflow waits for.
   */
  private _recoveredWorkflowPrompt(): ThinkWorkflowPromptContext | undefined {
    const acceptance = recoveredTurnAcceptanceContext.getStore();
    return acceptance?.agent === this ? acceptance.workflowPrompt : undefined;
  }

  async _chatRecoveryRetry(data?: ChatRecoveryRetryData): Promise<void> {
    await this._chatRecoveryEngine().runRecoveryCallback(
      "_chatRecoveryRetry",
      data
    );
  }

  protected async _chatRecoveryRetryDetached(
    data?: ChatRecoveryRetryData,
    onTurnStarted?: () => void
  ): Promise<void> {
    const host = this._recoveredTurnHost("_chatRecoveryRetry", data);
    await this._chatRecoveryEngine().runRecoveredTurn({
      ...host,
      ...this._recoveryRetrySteps(
        host,
        data,
        {
          targetUserId: data?.targetUserId,
          regeneratedLeafId: data?.regeneratedLeafId
        },
        onTurnStarted
      ),
      // Being superseded is benign: the submission ends `skipped`, never
      // `error`.
      onSkipped: () => host.completeSubmission("skipped", null, null),
      afterOutcome: (result) =>
        host.completeSubmission(
          result.status,
          result.requestId || null,
          result.status === "completed"
            ? null
            : (result.error ?? `Recovery retry ${result.status}.`),
          true
        )
    });
  }

  /**
   * The leaf check and the turn of a recovery that answers the latest
   * question again: a retry attempt, and a continue attempt whose reply held
   * nothing and was removed.
   */
  private _recoveryRetrySteps(
    host: {
      submission(): ThinkSubmissionRow | null;
      turnSignal(signal: AbortSignal): AbortSignal;
    },
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined,
    target: { targetUserId?: string; regeneratedLeafId?: string },
    onTurnStarted?: () => void
  ): {
    checkLeaf(): Promise<RecoveryLeafCheck>;
    runTurn(
      signal: AbortSignal,
      context: PinnedTurnContext
    ): Promise<ProgrammaticMessagesResult>;
  } {
    const { regeneratedLeafId, targetUserId } = target;
    return {
      checkLeaf: async () => {
        const lastLeaf = await this._recoveryLeaf();
        if (
          !lastLeaf ||
          (regeneratedLeafId === undefined && lastLeaf.role !== "user")
        ) {
          // The user turn is no longer the leaf: it was answered, or the
          // conversation moved on.
          return { moved: true, reason: "no_unanswered_user_message" };
        }
        const expectedLeafId = regeneratedLeafId ?? targetUserId;
        if (expectedLeafId && lastLeaf.id !== expectedLeafId) {
          return { moved: true, reason: "conversation_changed" };
        }
        return { moved: false };
      },
      runTurn: (signal, context) =>
        this._runRecoveredTurnAfterAcceptance(
          host.submission(),
          onTurnStarted,
          () =>
            this._retryLastUserTurn({
              ...context,
              signal: host.turnSignal(signal),
              trigger: "recovery-retry",
              ...(regeneratedLeafId !== undefined && {
                branchParentId: targetUserId
              })
            })
        )
    };
  }

  /**
   * The steps of a recovery attempt that are the same for a continue and a
   * retry: the shared plumbing, and the durable submission the attempt may
   * own. `ChatRecoveryEngine.runRecoveredTurn` owns their order.
   */
  private _recoveredTurnHost<
    TData extends ChatRecoveryContinueData | ChatRecoveryRetryData
  >(callback: ChatRecoveryScheduleCallback, data: TData | undefined) {
    const recoveredRequestId = data?.recoveredRequestId;
    let submission: ThinkSubmissionRow | null = null;
    let controller: AbortController | null = null;
    const completeSubmission = async (
      status: ThinkSubmissionStatus,
      requestId: string | null,
      errorMessage: string | null,
      // After the turn ran, complete the row read at admission: the accepted
      // turn moved its `request_id` to its own.
      afterTurn = false
    ): Promise<void> => {
      if (!recoveredRequestId) return;
      await this._completeRecoveredSubmission(
        afterTurn ? (submission ?? recoveredRequestId) : recoveredRequestId,
        status,
        requestId,
        errorMessage
      );
    };
    return {
      callback,
      data,
      /** The running submission this attempt completes, if it has one. */
      submission: () => submission,
      completeSubmission,
      /** The stop signal joined with the submission's own abort. */
      turnSignal: (stop: AbortSignal) =>
        controller ? AbortSignal.any([controller.signal, stop]) : stop,
      admit: async () => {
        // The turn of an agent-tool run its parent cancelled is not
        // recovered, and a submission the recovery owned settles `aborted`.
        if (
          !(await this._agentToolRuns.admitRecoveredTurn(
            data,
            (incidentId, status, reason) =>
              this._chatRecoveryEngine().updateIncident(
                incidentId,
                status,
                reason
              )
          ))
        ) {
          await completeSubmission("aborted", null, null);
          return false;
        }
        if (!recoveredRequestId) return true;
        submission = this._readRunningSubmissionForRecovery(recoveredRequestId);
        if (!submission) {
          await this._chatRecoveryEngine().updateIncident(
            data?.incidentId,
            "skipped",
            "submission_not_running"
          );
          return false;
        }
        controller = new AbortController();
        this._submissionAbortControllers.set(
          submission.submission_id,
          controller
        );
        return true;
      },
      release: () => {
        if (submission) {
          this._submissionAbortControllers.delete(submission.submission_id);
        }
      },
      // A submission the recovery owned settles as `aborted`.
      onStopped: () => completeSubmission("aborted", null, null),
      // The recovery loop is the submission's only completion driver after a
      // restart, and the client's answer continues the conversation as its
      // own turn. A reply that ended on a client tool call is what a
      // submission that was never interrupted completes on, so complete it.
      onClientContinued: () => completeSubmission("completed", null, null),
      // Before the incident settles: once it is terminal, nothing re-emits
      // the event that would settle a messenger reply after a reset.
      beforeOutcome: (result: SaveMessagesResult) =>
        this._stageMessengerRecoveryOutcome(data, result.status)
    };
  }

  /**
   * Recovery payloads retain the original submission/root identity while
   * request_id follows the accepted successor. Match both so released payloads,
   * redeferred callbacks, and exhaustion can still locate the running row.
   * Exact submission identity wins even when terminal: a redelivery must not
   * fall through to another submission whose successor request collides.
   */
  private _readRunningSubmissionForRecovery(
    recoveredRequestId: string
  ): ThinkSubmissionRow | null {
    this._ensureSubmissionTable();
    const rows = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at, result_status, output_json,
             message_id
      FROM cf_think_submissions
      WHERE submission_id = ${recoveredRequestId}
         OR (request_id = ${recoveredRequestId} AND status = 'running')
      ORDER BY (submission_id = ${recoveredRequestId}) DESC
      LIMIT 1
    `;
    return rows[0]?.status === "running" ? rows[0] : null;
  }

  private async _markRecoveredSubmissionInterrupted(
    recoveredRequestId: string,
    message: string
  ): Promise<void> {
    const row = this._readRunningSubmissionForRecovery(recoveredRequestId);
    if (!row) return;
    this.sql`
      UPDATE cf_think_submissions
      SET status = 'error',
          error_message = ${message},
          completed_at = ${Date.now()},
          result_status = NULL,
          output_json = NULL
      WHERE submission_id = ${row.submission_id}
        AND status = 'running'
    `;
    const updated = this._readSubmission(row.submission_id);
    if (updated?.status === "error") {
      this._enqueueTerminalWorkflowNotification(updated);
      await this._emitSubmissionStatus(updated);
    }
  }

  private async _completeRecoveredSubmission(
    recoveredSubmission: ThinkSubmissionRow | string,
    status: ThinkSubmissionStatus,
    requestId: string | null,
    errorMessage: string | null
  ): Promise<void> {
    const row =
      typeof recoveredSubmission === "string"
        ? this._readRunningSubmissionForRecovery(recoveredSubmission)
        : this._readSubmission(recoveredSubmission.submission_id);
    // No await between this guard and the status write/notification enqueue:
    // competing startup and detached-finalizer paths cannot both emit.
    if (row?.status !== "running") return;
    let output: unknown;
    if (row.result_status === "completed" || row.result_status === "aborted") {
      status = row.result_status;
      errorMessage = null;
      if (status === "completed" && row.output_json !== null) {
        output = JSON.parse(row.output_json);
      }
    } else if (row.result_status === "error" && status === "completed") {
      // A stamped stream error contradicts inferred success: no later cutover
      // replaced the stamp, so the turn never durably produced an answer.
      status = "error";
      errorMessage = "Recovered chat stream had already errored.";
    } else if (row.result_status === "retry" && status === "completed") {
      // A retry segment is not a terminal result. If durable recovery still
      // owns the work leave it running; otherwise use the interruption path.
      if (
        (row.request_id &&
          this._hasRecoverableChatTurn(row.request_id) &&
          this._hasFreshRecoverableSubmissionEvidence(row)) ||
        (await this._hasScheduledChatRecovery(row))
      )
        return;
      await this._markRecoveredSubmissionInterrupted(
        row.submission_id,
        "Submission was interrupted after messages were applied."
      );
      return;
    }
    const completedAt = Date.now();
    const streamId = requestId
      ? (this._resumableStream.latestStreamInfoForRequest(requestId)?.id ??
        null)
      : null;
    this.ctx.storage.transactionSync(() => {
      this.sql`
        UPDATE cf_think_submissions
        SET status = ${status},
            request_id = COALESCE(${requestId}, request_id),
            stream_id = COALESCE(${streamId}, stream_id),
            error_message = ${errorMessage},
            completed_at = ${completedAt},
            result_status = NULL,
            output_json = NULL
        WHERE submission_id = ${row.submission_id}
          AND status = 'running'
      `;
      this._enqueueTerminalWorkflowNotification(
        this._readSubmission(row.submission_id),
        output
      );
    });
    const updated = this._readSubmission(row.submission_id);
    if (updated && this._isTerminalSubmissionStatus(updated.status)) {
      await this._emitSubmissionStatus(updated);
    }
  }

  protected async onChatRecovery(
    _ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions | void> {
    return {};
  }

  async _chatRecoveryContinue(data?: ChatRecoveryContinueData): Promise<void> {
    await this._chatRecoveryEngine().runRecoveryCallback(
      "_chatRecoveryContinue",
      data
    );
  }

  protected async _chatRecoveryContinueDetached(
    data?: ChatRecoveryContinueData,
    onTurnStarted?: () => void
  ): Promise<void> {
    const targetId = data?.targetAssistantId;
    const host = this._recoveredTurnHost("_chatRecoveryContinue", data);
    // Whether a newer user turn, not recovery's own later continuation, is
    // what moved the leaf.
    let supersededByNewerUserTurn = false;
    await this._chatRecoveryEngine().runRecoveredTurn({
      ...host,
      settleCutOffReply: async (removal) =>
        targetId
          ? this._settleBeforeRecovery(targetId, {
              ...removal,
              originMessageIds: data?.originMessageIds
            })
          : undefined,
      // The reply is not in the transcript (it held nothing and was removed,
      // by this attempt or an earlier run of it): answer the question again.
      retryLostReply: this._recoveryRetrySteps(host, data, {}, onTurnStarted),
      checkLeaf: async () => {
        const lastLeaf = await this._recoveryLeaf();
        if (!targetId || lastLeaf?.id === targetId) return { moved: false };
        supersededByNewerUserTurn = lastLeaf?.role === "user";
        return { moved: true, reason: "conversation_changed" };
      },
      // The target is no longer the leaf. Never an error for the submission:
      //  - an assistant leaf means recovery's own later continuation advanced
      //    this turn. Leave the submission to that continuation.
      //  - a user leaf means a newer turn superseded this one. Mark the
      //    submission `skipped` so it does not wait on a turn nobody finishes.
      onSkipped: async () => {
        if (supersededByNewerUserTurn) {
          await host.completeSubmission("skipped", null, null);
        }
      },
      runTurn: (signal, context) =>
        this._runRecoveredTurnAfterAcceptance(
          host.submission(),
          onTurnStarted,
          () =>
            this.continueLastTurn(undefined, {
              ...context,
              signal: host.turnSignal(signal),
              trigger: "recovery-continue"
            })
        ),
      afterOutcome: (result) =>
        host.completeSubmission(
          result.status,
          result.requestId || null,
          result.status === "completed"
            ? null
            : (result.error ?? `Recovery ${result.status}.`),
          true
        )
    });
  }

  private _getPartialStreamText(streamId: string): {
    text: string;
    parts: MessagePart[];
    hasSettledToolResults: boolean;
  } {
    return aiSdkRecoveryCodec.toRecoveryPartial(
      this._resumableStream.getStreamChunks(streamId).map((chunk) => chunk.body)
    );
  }

  // ── Concurrency strategies ──────────────────────────────────────

  private _completeSkippedRequest(
    connection: Connection | null,
    requestId: string
  ): void {
    this._frames.endUnstarted(connection, requestId, "skipped");
    // A skipped turn settles out of the pre-stream set, but must NOT release
    // parked connections (#1784): a skip happens because a NEWER turn was
    // admitted (latest/merge supersede) or the queue generation advanced. The
    // earliest "successor exists" signal (`SubmitConcurrencyController.decide`)
    // fires before the successor's `_preStream.begin()`, so releasing here would
    // race a `begin()` that hasn't run yet and cut a parked client loose right
    // before the successor streams. Leave it parked: the successor flushes it on
    // stream start, or the final surviving turn's settle releases it. (Chat
    // clear releases parked connections explicitly via `resetTurnState`.)
    this._turns.settlePreStreamTurn(requestId, { releaseParked: false });
  }

  private _rollbackDroppedSubmit(connection: Connection): void {
    connection.send(JSON.stringify(this._messagesFrame()));
  }

  // ── Auto-continuation ──────────────────────────────────────────

  private _continuationSpec(connection: Connection) {
    return {
      connection,
      errorPrefix: "[Think] Auto-continuation failed:"
    };
  }

  /**
   * Re-arm the barrier for a tool result/approval that arrived WITHOUT
   * `autoContinue` (#1650). The client sends `autoContinue: false` for an
   * errored tool result (it declines to auto-continue a standalone error), but
   * in a parallel batch a SIBLING may already have requested continuation — and
   * this result can be the one that completes the batch. In that case we must
   * re-run the barrier check so the continuation the sibling requested still
   * fires once the batch is whole.
   *
   * Unlike `_scheduleAutoContinuation` this never CREATES a pending
   * continuation: a standalone errored tool (no opted-in sibling, so no pending)
   * must not auto-continue. It also no-ops once the continuation is running
   * (`pastCoalesce`) — a late result then defers/applies through the normal
   * path rather than re-arming.
   */
  private _rearmPendingAutoContinuationForBatch(): void {
    this._autoContinuation.rearmForBatch();
  }

  /**
   * A pause resolved while its turn streamed: apply its deferred drop now
   * that the reply is stored. The turn core re-checks the continuations the
   * reply held right after (#1650).
   */
  private _flushResolvedPausesAfterReply(): void {
    if (!this._flushResolvedPausesOnFinalize) return;
    this._flushResolvedPausesOnFinalize = false;
    void this.keepAliveWhile(() =>
      this._enqueueInteractionApply(() => this._flushDeferredResolvedPauses())
    ).catch((error) => {
      console.error("[Think] Failed to apply resolved pauses", error);
    });
  }

  /**
   * A pause resolved without a continuation while its turn was streaming; its
   * deferred drop runs when that turn finalizes instead of at the next
   * inference.
   */
  private _flushResolvedPausesOnFinalize = false;

  /**
   * How a turn that failed before it streamed reaches clients and the app.
   * The turn core owns the order (`reportTurnFailure`): `onChatError` and
   * `chat:request:failed`, the terminal status, then the error frame, for a
   * client request and a continuation alike. A failed continuation also
   * gets `onChatResponse`, once its turn has left the queue.
   */
  private _turnFailureHost(): TurnFailureHost<UIMessage> {
    return {
      describe: ({ error, requestId, continuation, stage = "turn" }) => {
        const wrapped = this.onChatError(error, {
          requestId,
          stage,
          messagesPersisted: stage === "turn",
          ...(continuation && { continuation: true })
        });
        const errorMessage =
          wrapped instanceof Error ? wrapped.message : String(wrapped);
        this._emit("chat:request:failed", {
          requestId,
          stage,
          messagesPersisted: stage === "turn",
          error: errorMessage
        });
        return errorMessage;
      },
      recordTerminal: (requestId, errorMessage) =>
        this._recordTerminalChatStatus("error", requestId, errorMessage),
      broadcast: (frame) => this._frames.broadcast({ ...frame }),
      // Called once the turn has left the queue. A continuation that was
      // activated while another turn settled was fired inside that turn's
      // admission context, and code after its own turn still runs in it, so
      // leave it: the hook may start a turn of its own.
      respond: (result) =>
        admittedTurnContext.exit(() => this._fireLiveResponseHook(result))
    };
  }

  /**
   * What a continuation turn is here: the admission, the turn body
   * (`_runModelTurn` with `continuation: true`, the same one every other
   * turn runs, so a continuation gets context-overflow recovery too), and
   * how a failure before the stream reaches clients and the app
   * (`onChatError`, `chat:request:failed`, the terminal status, the error
   * frame, `onChatResponse`).
   */
  private _continuationTurn(): ContinuationTurn<Connection, UIMessage> {
    return {
      enqueue: (requestId, turn) =>
        this._admitTurn({
          admission: "queue",
          trigger: "auto-continuation",
          requestId,
          continuation: true,
          inheritChannel: true,
          allowNested: true,
          execute: async () => {
            // The core reads the transcript to decide whether the turn has
            // anything to answer. Text written after a pause that has since
            // resolved is still stored when the pause resolved mid-stream
            // (or before a restart), and would read as the model's answer.
            await this._flushDeferredResolvedPauses();
            return turn();
          }
        }),
      // The one turn body every turn runs, for the continuation's
      // connection and tools.
      run: ({ requestId, connection }, signal) =>
        this._runModelTurn(requestId, signal, {
          continuation: true,
          connection,
          clientTools: this._lastClientTools,
          body: this._lastBody
        }),
      failure: this._turnFailureHost(),
      onError: (error, { errorPrefix, reported }) => {
        if (!reported) {
          console.error(
            errorPrefix ?? "[Think] Auto-continuation failed:",
            error
          );
        }
      }
    };
  }

  /**
   * Queue a continuation turn that does NOT require a live client connection.
   *
   * Used when a durable approval (a paused action or codemode execution) is
   * resolved via RPC from a surface with no open chat socket — e.g. an ops
   * dashboard, a webhook, or a voice backend approving hours/days later. The
   * item is durable, so the turn still runs if the object leaves memory
   * before the alarm fires; the last request body and client tools it needs
   * are persisted config, restored on start. Approvals landing while one
   * continuation is pending or running coalesce onto the single item, which
   * records the message each one's outcome is stored in
   * (`targetMessageId`): the continuation answers those messages, and runs
   * only while one of them is the latest, like any other.
   */
  private async _queueConnectionlessContinuation(
    targetMessageId: string
  ): Promise<void> {
    // A push with the item's id replaces its payload, so carry over the
    // messages the approvals already coalesced onto it answer. Applies run
    // one at a time, so no other push lands between the read and the push.
    // A push while the item's callback runs supersedes that run's outcome:
    // the item is kept and runs again with this payload.
    const queued = await this.getQueue<ConnectionlessContinuation>(
      CONNECTIONLESS_CONTINUATION_QUEUE_ID
    );
    const targetMessageIds = addContinuationTarget(
      queued?.payload?.targetMessageIds,
      targetMessageId
    );
    await this.queue<ConnectionlessContinuation>(
      CONNECTIONLESS_CONTINUATION_CALLBACK,
      {
        targetMessageIds: [...targetMessageIds],
        stops: this._connectionlessStops()
      },
      { id: CONNECTIONLESS_CONTINUATION_QUEUE_ID }
    );
  }

  /**
   * Run one connection-less continuation turn: the same turn as a
   * connection-bound continuation (`ChatTurns.runUnscheduledContinuationTurn`),
   * with no connection and the stored client tools. It streams via
   * `broadcast` (a no-op when nobody is attached) and always persists, so a
   * client that reconnects later resumes the continued turn from history.
   * @internal Queue callback.
   */
  async _cfRunConnectionlessContinuation(
    queued?: ConnectionlessContinuation
  ): Promise<void> {
    // An item an older version queued names no message: it answers the
    // latest one.
    const latest = this.messages.at(-1)?.id;
    const targetMessageIds =
      queued?.targetMessageIds ?? (latest === undefined ? [] : [latest]);
    // Pushed before a later stop of every chat: the stop drops it here.
    if (
      queued?.stops !== undefined &&
      queued.stops < this._connectionlessStops()
    ) {
      this._emit("chat:continuation:dropped", {
        requestId: null,
        reason: "stopped"
      });
      return;
    }
    await this._turns.runUnscheduledContinuationTurn(
      this._continuationTurn(),
      {
        requestId: crypto.randomUUID(),
        connection: undefined,
        targetMessageIds
      },
      "[Think] Connection-less continuation failed:"
    );
  }

  // ── Response hook ──────────────────────────────────────────────

  /**
   * Render a reply attachment ({@link ReplyAttachment}) for delivery to the
   * active channel. Returns the text/markdown to post, or `undefined` to skip —
   * unknown types, or types a channel handles out of band (e.g. `voice_note`
   * via the voice transport). Override to customize per app/channel.
   */
  renderAttachment(
    attachment: ReplyAttachment
  ): string | { markdown: string } | undefined {
    return defaultAttachmentText(attachment);
  }

  /** Deliver known reply attachments to the active channel; never throws. */
  private _renderChannelAttachments(
    attachments: ReplyAttachment[] | undefined
  ): Promise<void> {
    return deliverReplyAttachments(
      attachments,
      (attachment) => this.renderAttachment(attachment),
      (rendered) => this.deliverNotice(rendered, { kind: "interim" })
    );
  }

  private async _fireResponseHook(result: ChatResponseResult): Promise<void> {
    // Surface advisory reply attachments recorded during this turn.
    result.attachments = this.replyAttachments(result.requestId);
    // Record the channel-level delivery for this turn (the turn-scoped channel
    // context is still set here — the response hook runs inside the turn body).
    const deliveredChannel = this._activeChannelContext;
    if (deliveredChannel) {
      this._emitChannelEvent({
        type: "channel:delivered",
        payload: {
          channel: deliveredChannel.channelId,
          kind: "final",
          turnEnded: true
        }
      });
    }
    await this._renderChannelAttachments(result.attachments);
    // Record the terminal status durably so a client connecting after the turn
    // ended still learns its outcome (see `_buildIdleConnectMessages`).
    await this._recordTerminalChatStatus(
      result.status,
      result.requestId,
      result.error ?? "The assistant was interrupted."
    );
    if (this._insideResponseHook) return;
    this._insideResponseHook = true;
    try {
      // The hook is the app's. Nothing it starts belongs to a recovery
      // attempt whose turn this was.
      await this._chatRecoveryEngine().outsideAttempt(() =>
        this.onChatResponse(result)
      );
    } catch (err) {
      console.error("[Think] onChatResponse error:", err);
    } finally {
      this._insideResponseHook = false;
    }
  }

  /**
   * Fire a live turn's response hook, then drop its pending marker. When the
   * bookkeeping before `onChatResponse` throws (attachment delivery, the
   * terminal-status write), the hook has not run: the marker is kept, with
   * this outcome, so the next start replays it.
   */
  private async _fireLiveResponseHook(
    result: ChatResponseResult
  ): Promise<void> {
    try {
      await this._fireResponseHook(result);
    } catch (error) {
      console.error("[Think] onChatResponse deferred to replay:", error);
      await this._rememberPendingResponseHook(result).catch(() => {});
      this._responseHooksInFlight.delete(result.requestId);
      return;
    }
    await this._forgetPendingResponseHook(result.requestId).catch(
      (error: unknown) => {
        console.error("[Think] failed to clear a response hook marker:", error);
      }
    );
  }

  /** Request ids whose response hook the live turn still owes. */
  private _responseHooksInFlight = new Set<string>();
  private _pendingResponseHookReplay: Promise<void> | undefined;

  /**
   * Record, before the assistant message is persisted, that this turn owes
   * `onChatResponse`, so a reset between the persist and the hook replays it.
   */
  private async _rememberPendingResponseHook(
    result: ChatResponseResult
  ): Promise<void> {
    this._responseHooksInFlight.add(result.requestId);
    const pending: PendingResponseHook = {
      requestId: result.requestId,
      messageId: result.message.id,
      continuation: result.continuation,
      status: result.status,
      ...(result.error !== undefined && { error: result.error })
    };
    await this.ctx.storage.put(
      PENDING_RESPONSE_HOOK_PREFIX + result.requestId,
      pending
    );
  }

  private async _forgetPendingResponseHook(requestId: string): Promise<void> {
    await this.ctx.storage.delete(PENDING_RESPONSE_HOOK_PREFIX + requestId);
    this._responseHooksInFlight.delete(requestId);
  }

  /**
   * Fire the response hooks a reset interrupted. A hook whose message never
   * persisted is dropped: that turn is recovered, and fires, on its own.
   */
  private _replayPendingResponseHooks(requestId?: string): Promise<void> {
    const previous = this._pendingResponseHookReplay ?? Promise.resolve();
    const replay = previous
      .catch(() => {})
      .then(() => this._replayPendingResponseHooksNow(requestId));
    const tracked = replay.finally(() => {
      if (this._pendingResponseHookReplay === tracked) {
        this._pendingResponseHookReplay = undefined;
      }
    });
    this._pendingResponseHookReplay = tracked;
    return tracked;
  }

  private async _replayPendingResponseHooksNow(
    requestId?: string
  ): Promise<void> {
    const pending =
      requestId === undefined
        ? await this.ctx.storage.list<PendingResponseHook>({
            prefix: PENDING_RESPONSE_HOOK_PREFIX
          })
        : new Map([
            [
              PENDING_RESPONSE_HOOK_PREFIX + requestId,
              await this.ctx.storage.get<PendingResponseHook>(
                PENDING_RESPONSE_HOOK_PREFIX + requestId
              )
            ]
          ]);
    for (const [key, hook] of pending) {
      if (!hook || this._responseHooksInFlight.has(hook.requestId)) continue;
      // Chat recovery reads this marker to settle the turn instead of
      // re-running it, so leave it for recovery while the turn is pending.
      if (
        requestId === undefined &&
        this._hasRecoverableChatTurn(hook.requestId)
      ) {
        continue;
      }
      const message = await this.session.getMessage(hook.messageId);
      if (message) {
        await this._fireResponseHook({
          message: message as UIMessage,
          requestId: hook.requestId,
          continuation: hook.continuation,
          status: hook.status,
          ...(hook.error !== undefined && { error: hook.error }),
          recovered: true
        });
      }
      await this.ctx.storage.delete(key);
    }
  }

  /** Request ids whose interruption handed messenger delivery to recovery. */
  private _messengerRecoveryClaims = new Set<string>();

  /**
   * An interrupted messenger turn that recovery will continue: record where
   * the recovered answer goes before the continuation is scheduled, so the
   * messenger delivery can skip its apology (#2106). A continuation attempt
   * of the same incident keeps the existing record.
   */
  private async _claimMessengerRecoveryDelivery(
    requestId: string,
    incidentId: string,
    partialText: string
  ): Promise<void> {
    const context = this._activeMessengerContext();
    if (!context) return;
    const delivery: MessengerRecoveryDelivery = {
      messengerId: context.messengerId,
      threadId: context.thread.id,
      partialText
    };
    await this.ctx.storage.put(
      MESSENGER_RECOVERY_PREFIX + incidentId,
      delivery
    );
    this._messengerRecoveryClaims.add(requestId);
  }

  /**
   * Durably record a messenger reply's outcome before its recovery incident
   * settles: once the incident is terminal, nothing re-emits the event that
   * would settle the reply after a reset. The recovered text is read before
   * any await, so a later turn cannot replace it.
   */
  private async _stageMessengerRecoveryOutcome(
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined,
    status: SaveMessagesResult["status"]
  ): Promise<void> {
    if (!data?.incidentId) return;
    const text =
      status === "completed" ? this._recoveredReplyText(data) : undefined;
    const key = MESSENGER_RECOVERY_PREFIX + data.incidentId;
    const delivery = await this.ctx.storage.get<MessengerRecoveryDelivery>(key);
    if (!delivery || delivery.outcome) return;
    await this.ctx.storage.put(
      key,
      settleMessengerRecoveryDelivery(
        delivery,
        text === undefined ? "interrupted" : "completed",
        text
      )
    );
  }

  private _recoveredReplyText(
    data: ChatRecoveryContinueData | ChatRecoveryRetryData
  ): string {
    const messages = this.messages;
    let reply: UIMessage | undefined;
    if ("targetAssistantId" in data && data.targetAssistantId) {
      reply = messages.find((m) => m.id === data.targetAssistantId);
    } else if ("targetUserId" in data && data.targetUserId) {
      const index = messages.findIndex((m) => m.id === data.targetUserId);
      const next = index >= 0 ? messages[index + 1] : undefined;
      if (next?.role === "assistant") reply = next;
    }
    reply ??= messages.filter((m) => m.role === "assistant").at(-1);
    return messageText(reply);
  }

  /** Incidents whose messenger reply is being delivered by this isolate. */
  private _settlingMessengerRecoveries = new Set<string>();

  private _settleMessengerRecovery(
    incidentId: string,
    outcome: "completed" | "interrupted"
  ): void {
    const text =
      outcome === "completed"
        ? messageText(
            this.messages.filter((m) => m.role === "assistant").at(-1)
          )
        : undefined;
    if (this._settlingMessengerRecoveries.has(incidentId)) return;
    this._settlingMessengerRecoveries.add(incidentId);
    const key = MESSENGER_RECOVERY_PREFIX + incidentId;
    void this.keepAliveWhile(async () => {
      let delivery = await this.ctx.storage.get<MessengerRecoveryDelivery>(key);
      if (!delivery) return;
      if (!delivery.outcome) {
        delivery = settleMessengerRecoveryDelivery(delivery, outcome, text);
        await this.ctx.storage.put(key, delivery);
      }
      await this._deliverMessengerRecovery(key);
    })
      .catch((error: unknown) =>
        this._retryMessengerRecoveryDeliveryLater(key, 0, error)
      )
      .finally(() => {
        this._settlingMessengerRecoveries.delete(incidentId);
      });
  }

  /** The latest delivery of each recovered reply key, in call order. */
  private _messengerRecoveryDeliveries = new Map<string, Promise<void>>();

  /**
   * Deliver a recovered reply after any delivery of the same key already
   * running in this isolate: startup replay, live settlement and scheduled
   * retries interleave across awaits, and each must see the cursor the
   * previous one advanced.
   */
  private async _deliverMessengerRecovery(key: string): Promise<void> {
    const previous = this._messengerRecoveryDeliveries.get(key);
    const run = (previous ?? Promise.resolve()).then(() =>
      this._postMessengerRecovery(key)
    );
    const tail = run.catch(() => {});
    this._messengerRecoveryDeliveries.set(key, tail);
    try {
      await run;
    } finally {
      if (this._messengerRecoveryDeliveries.get(key) === tail) {
        this._messengerRecoveryDeliveries.delete(key);
      }
    }
  }

  /**
   * Post a settled recovered reply, one post at a time, then drop its record.
   * Each post goes out at most once: the cursor advances before it, and a
   * rejected post may still have landed (a timeout after the platform
   * accepted it), so the retry resumes with the next post.
   */
  private async _postMessengerRecovery(key: string): Promise<void> {
    let delivery = await this.ctx.storage.get<MessengerRecoveryDelivery>(key);
    if (!delivery?.outcome) return;
    const input = {
      messengerId: delivery.messengerId,
      threadId: delivery.threadId,
      outcome: delivery.outcome,
      ...(delivery.text !== undefined && { text: delivery.text }),
      partialPosted: delivery.partialText.trim().length > 0
    };
    const parent = this.parentPath.at(-1);
    // `parentAgent` resolves the parent by class name only.
    const host = parent
      ? await this.parentAgent({
          name: parent.className
        } as unknown as SubAgentClass<Think>)
      : this;
    let chunks: number | undefined;
    for (;;) {
      delivery = await this.ctx.storage.get<MessengerRecoveryDelivery>(key);
      if (!delivery?.outcome) return;
      const posted = delivery.posted ?? 0;
      if (chunks !== undefined && posted >= chunks) break;
      await this.ctx.storage.put(key, { ...delivery, posted: posted + 1 });
      ({ chunks } = await host._cf_deliverRecoveredMessengerReply({
        ...input,
        chunk: posted
      }));
    }
    await this.ctx.storage.delete(key);
  }

  /** Retry a recovered messenger reply whose live delivery failed. */
  private async _retryMessengerRecoveryDeliveryLater(
    key: string,
    attempts: number,
    error: unknown
  ): Promise<void> {
    if (attempts >= MESSENGER_RECOVERY_MAX_RETRIES) {
      console.error(
        `[Think] recovered messenger reply delivery failed ${attempts + 1} times; the next wake replays it`,
        error
      );
      return;
    }
    const delaySeconds = 2 ** (attempts + 1);
    console.error(
      `[Think] recovered messenger reply delivery failed; retrying in ${delaySeconds}s`,
      error
    );
    try {
      await this.schedule(delaySeconds, MESSENGER_RECOVERY_RETRY_CALLBACK, {
        key,
        attempts: attempts + 1
      });
    } catch (scheduleError) {
      console.error(
        "[Think] failed to schedule a recovered messenger reply retry",
        scheduleError
      );
    }
  }

  /**
   * Retry delivering a recovered messenger reply (see
   * {@link _retryMessengerRecoveryDeliveryLater}).
   * @internal Schedule callback.
   */
  async _cfRetryMessengerRecoveryDelivery(payload: {
    key: string;
    attempts: number;
  }): Promise<void> {
    try {
      await this._deliverMessengerRecovery(payload.key);
    } catch (error) {
      await this._retryMessengerRecoveryDeliveryLater(
        payload.key,
        payload.attempts,
        error
      );
    }
  }

  private async _replayMessengerRecoveryDeliveries(): Promise<void> {
    const pending = await this.ctx.storage.list<MessengerRecoveryDelivery>({
      prefix: MESSENGER_RECOVERY_PREFIX
    });
    for (const [key, delivery] of pending) {
      if (!delivery.outcome) {
        // Settled while an earlier isolate was delivering: the incident is
        // gone or gave up, and no event will settle this record again.
        const incident = await this.ctx.storage.get<ChatRecoveryIncident>(
          CHAT_RECOVERY_INCIDENT_KEY_PREFIX +
            encodeURIComponent(key.slice(MESSENGER_RECOVERY_PREFIX.length))
        );
        if (
          incident &&
          incident.status !== "skipped" &&
          incident.status !== "exhausted"
        ) {
          continue;
        }
        await this.ctx.storage.put(
          key,
          settleMessengerRecoveryDelivery(delivery, "interrupted")
        );
      }
      try {
        await this._deliverMessengerRecovery(key);
      } catch (error) {
        await this._retryMessengerRecoveryDeliveryLater(key, 0, error);
      }
    }
  }

  /**
   * Persist (on `error`/`interrupted`) or clear (on `completed`/`aborted`) the
   * durable terminal record so it can be replayed to clients on reconnect, and
   * resolve any in-progress "recovering…" indicator. A `completed`/`aborted`
   * turn is conveyed by the persisted messages, so the record is cleared; an
   * `error`/`interrupted` turn has no durable trace otherwise, so it is kept
   * until a later turn supersedes it.
   *
   * The storage primitives are shared with `@cloudflare/ai-chat`
   * (`_recordChatTerminal` / `_clearChatTerminal` / `_pendingChatTerminal`).
   */
  private async _recordTerminalChatStatus(
    status: ChatResponseResult["status"] | "interrupted",
    requestId: string,
    body: string,
    messageIds?: string[]
  ): Promise<void> {
    if (status === "error" || status === "interrupted") {
      await this._recordChatTerminal(requestId, body, messageIds);
    } else {
      // Not the record of this turn's own give-up.
      await this._clearChatTerminal(requestId);
    }
    // Any terminal turn outcome resolves an in-progress recovery (#1620): a
    // recovered turn that completes, errors, or is exhausted must clear the
    // "recovering…" indicator so it never spins forever.
    await this._setChatRecovering(false);
  }

  /**
   * Persist a durable record of the last terminal turn so a client that
   * (re)connects after the turn ended still learns its outcome (#1645). Kept
   * until a later turn supersedes it (`_clearChatTerminal`); a single record is
   * sufficient because only the most recent terminal is relevant.
   */
  private async _recordChatTerminal(
    requestId: string,
    body: string,
    messageIds = this._frames.originIds(requestId)
  ): Promise<void> {
    await recordChatTerminal(this.ctx.storage, requestId, body, messageIds);
  }

  /** Clear the durable terminal record once a later turn supersedes it (#1645). */
  private async _clearChatTerminal(endedRequestId?: string): Promise<void> {
    await clearChatTerminal(this.ctx.storage, endedRequestId);
  }

  private async _pendingChatTerminal(): Promise<{
    requestId: string;
    body: string;
    messageIds?: string[];
  } | null> {
    return pendingChatTerminal(this.ctx.storage);
  }

  /**
   * Set or clear the live "recovering…" status for a durable chat turn (#1620).
   * Persists a durable record (replayed on connect via `_buildIdleConnectMessages`)
   * and broadcasts a `MSG_CHAT_RECOVERING` frame — but only on a genuine
   * transition, so a deploy/reconnect storm (which re-detects recovery many
   * times) doesn't spam the wire. Cleared on every terminal outcome so the
   * indicator can't spin forever.
   */
  private async _setChatRecovering(
    active: boolean,
    requestId?: string
  ): Promise<void> {
    await setChatRecovering(active, requestId, {
      storage: this.ctx.storage,
      messageType: MSG_CHAT_RECOVERING,
      broadcast: (frame) => this._frames.broadcast(frame),
      now: Date.now()
    });
  }

  /**
   * Messages sent to a client on connect when no stream is active: the current
   * transcript, plus a replay of an in-progress "recovering…" status (if any).
   *
   * A terminal error is deliberately NOT replayed here. A bare
   * `MSG_CHAT_RESPONSE` frame on connect is dropped by the `useAgentChat`
   * client because it never reaches a transport stream reader, so it cannot
   * become `useChat.error` — a failed turn would still look frozen (#1645).
   * The terminal outcome is instead surfaced over the resume handshake (the
   * shared {@link ResumeHandshake} drives `STREAM_RESUMING` → ACK → terminal
   * error frame), the only path that lands on the stream reader.
   */
  private async _buildIdleConnectMessages(): Promise<
    Array<Record<string, unknown>>
  > {
    const messages: Array<Record<string, unknown>> = [
      this._messagesFrame({ connect: true })
    ];
    // Replay an in-progress "recovering…" status so a client that connects
    // mid-recovery reads the turn as working rather than frozen (#1620). This
    // is a plain status frame the client handles on connect (unlike a terminal
    // error, which must go through the resume handshake). It's mutually
    // exclusive with a terminal record (any terminal outcome clears recovering).
    // Skip a stale record (older than the flag TTL) so a turn whose recovery
    // was abandoned without a terminal can't show "recovering…" forever on
    // reconnect.
    const recoveringFrame = await buildChatRecoveringFrame(
      this.ctx.storage,
      MSG_CHAT_RECOVERING,
      Date.now()
    );
    if (recoveringFrame) {
      messages.push(recoveringFrame);
    }
    return messages;
  }

  // ── Resume helpers ──────────────────────────────────────────────

  /**
   * The shared resume-handshake driver (Tier-2). Lazily built; the
   * `ResumableStream` / `ContinuationState` / pending set are stable after
   * `onStart`, so a single instance threads them for the agent's lifetime. The
   * idle-connect payload (transcript + recovering, `_buildIdleConnectMessages`)
   * stays host-owned and is NOT part of the driver.
   */
  private _resumeHandshake(): ResumeHandshake {
    return (this._resumeHandshakeInstance ??= new ResumeHandshake({
      responseMessageType: MSG_CHAT_RESPONSE,
      resumableStream: this._resumableStream,
      continuation: this._continuation,
      preStream: this._preStream,
      pendingResumeConnections: this._pendingResumeConnections,
      pendingChatTerminal: () => this._pendingChatTerminal(),
      persistOrphanedStream: (streamId) =>
        this._persistOrphanedStream(streamId),
      isConnectionPresent: (connectionId) =>
        this.getConnection(connectionId) !== undefined,
      holdsTerminalFrames: (requestId) =>
        this._turns.liveReply?.requestId === requestId &&
        this._turns.liveReply.ended,
      recentTerminal: (requestIds) =>
        recentChatTerminal(this.ctx.storage.kv, requestIds)
    }));
  }

  /**
   * Notify a connection about an active stream that can be resumed — delegates
   * to the shared {@link ResumeHandshake}. Kept as a thin method because it is
   * also called proactively from onConnect and the broadcast loop. See the
   * driver for the #1733 double-send contract.
   */
  private _notifyStreamResuming(connection: Connection): void {
    this._resumeHandshake().notifyStreamResuming(connection);
  }

  /**
   * The message an orphaned stream's assistant message branches from, so the
   * reconstructed message lands where the live turn would have persisted it:
   * a regeneration beside the response it replaces, not under it. Undefined
   * for a turn that appends to the latest leaf, and on an `agents` release
   * that does not record the parent.
   */
  private _orphanParentId(streamId: string): string | undefined {
    const stream = this._resumableStream as ResumableStream & {
      getStreamParentMessageId?: (streamId: string) => string | null;
    };
    return stream.getStreamParentMessageId?.(streamId) ?? undefined;
  }

  /**
   * The assistant message a leaf-extending stream continues, and how many parts
   * it held when the stream started; undefined for a stream that produces a
   * message of its own. `_streamResult` records both when it starts the stream.
   *
   * Recovery keeps that many leading parts of the stored message, so it relies
   * on them staying put until the stream is recovered. That holds today: the
   * stream itself only adds parts after them, and once a stream is recovered
   * it is marked completed and reclaimed when the next stream starts, so a
   * later stream that extends the message again cannot be overwritten by a
   * replay.
   * (`_dropGenerationAfterResolvedPause` can trim an orphaned leaf; it only
   * drops text and reasoning written against a paused tool result.)
   */
  private _orphanContinuedMessage(
    streamId: string
  ): { messageId: string; basePartCount: number } | undefined {
    const messageId = this._resumableStream.getStreamMessageId(streamId);
    const basePartCount =
      this._resumableStream.getStreamBasePartCount(streamId);
    return messageId !== null && basePartCount !== null
      ? { messageId, basePartCount }
      : undefined;
  }

  private async _persistOrphanedStream(streamId: string): Promise<void> {
    this._resumableStream.flushBuffer();
    const chunks = this._resumableStream.getStreamChunks(streamId);
    if (chunks.length === 0) return;

    // The accumulate loop and the `getMessage → update(merge) XOR append` upsert
    // are the shared `persistReconstructedOrphan` core. Think supplies:
    //   - continues: for a stream that extended the assistant leaf (a recovery
    //     continuation), replay its chunks onto the leaf's parts from when the
    //     stream started, as the live accumulator did. Recovery then rewrites
    //     the leaf instead of appending a copy each time (#2780).
    //   - fallbackId: the id `_streamResult` recorded for a continuation, whose
    //     `start` chunk carries none (`_alignStreamStartId` skips them).
    //   - prepare: `_strippedForPersist` (same as `_persistAssistantMessage`) —
    //     drop the internal final-answer parts and skip (`null`) an empty
    //     structural-only assistant message.
    //   - merge: Think replaces the whole message (no partial merge).
    // NOTE: progress is bumped at production/flush time in `_storeChunkDurably`
    // (#1637), NOT here — persisting on recovery or a client reconnect must not
    // be miscounted as new forward progress.
    let persistedId: string | undefined;
    const store = this._orphanStore();
    const parentId = this._orphanParentId(streamId);
    const continued = this._orphanContinuedMessage(streamId);
    const wrote = await persistReconstructedOrphan(chunks, {
      store:
        parentId === undefined
          ? store
          : {
              ...store,
              appendMessage: (message) => store.appendMessage(message, parentId)
            },
      ...(continued && {
        continues: { ...continued, settleBasePart: settleInterruptedPart }
      }),
      fallbackId:
        this._resumableStream.getStreamMessageId(streamId) ??
        crypto.randomUUID(),
      prepare: (message) => {
        // A stream with no `finish` chunk was cut off: settle the calls it
        // left unanswered. One that finished and only missed its persist
        // keeps them: those wait for a client.
        const prepared = this._strippedForPersist(
          streamChunksFinished(chunks)
            ? message
            : this._settleInterruptedReply(message)
        );
        persistedId = prepared?.id;
        return prepared;
      },
      merge: (_existing, incoming) => incoming
    });
    if (!wrote) return;
    const requestId =
      this._resumableStream.getStreamMetadata(streamId)?.request_id;
    if (requestId && persistedId) {
      this._recordSubmissionMessage(requestId, persistedId);
    }
    this._broadcastMessages();
  }

  private _broadcast(message: Record<string, unknown>, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  /**
   * The message list tabs are sent: the transcript, then the messages
   * waiting requests hold, named in `queuedMessageIds`.
   */
  private _messagesFrame(extra?: Record<string, unknown>) {
    return {
      type: MSG_CHAT_MESSAGES,
      ...this._turns.clientView(this.messages),
      ...extra
    };
  }

  private _broadcastMessages(exclude?: string[]) {
    this._broadcast(this._messagesFrame(), exclude);
  }
}

// Register the HITL methods as client-callable. Imperative registration
// (rather than `@callable()` decorator syntax on the methods) because TC39
// decorators don't survive every consumer toolchain that compiles this file
// from source (e.g. esbuild targeting ES2021).
for (const method of [
  Think.prototype.pendingExecutions,
  Think.prototype.pendingApprovals,
  Think.prototype.approveExecution,
  Think.prototype.rejectExecution
]) {
  callable()(method, undefined as unknown as ClassMethodDecoratorContext);
}
