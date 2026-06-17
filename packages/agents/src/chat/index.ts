export {
  applyChunkToParts,
  isReplayChunk,
  normalizeToolInput,
  type MessageParts,
  type MessagePart,
  type StreamChunkData
} from "./message-builder";

export {
  sanitizeMessage,
  enforceRowSizeLimit,
  byteLength,
  ROW_MAX_BYTES
} from "./sanitize";

export {
  StreamAccumulator,
  type StreamAccumulatorOptions,
  type ChunkAction,
  type ChunkResult
} from "./stream-accumulator";

export { TurnQueue, type TurnResult, type EnqueueOptions } from "./turn-queue";

export {
  SubmitConcurrencyController,
  type NormalizedMessageConcurrency,
  type SubmitConcurrencyDecision
} from "./submit-concurrency";

export {
  transition as broadcastTransition,
  type BroadcastStreamState,
  type BroadcastStreamEvent,
  type TransitionResult as BroadcastTransitionResult
} from "./broadcast-state";

export { ResumableStream, type SqlTaggedTemplate } from "./resumable-stream";

export { MAX_BOUND_PARAMS, buildInClauseStrings } from "./sql-batch";

export {
  createToolsFromClientSchemas,
  type ClientToolSchema,
  type ClientToolExecutor
} from "./client-tools";

export { CHAT_MESSAGE_TYPES } from "./protocol";

export {
  applyAgentToolEvent,
  createAgentToolEventState,
  type AgentToolEvent,
  type AgentToolEventMessage,
  type AgentToolEventState,
  type AgentToolRunState
} from "./agent-tools";

export {
  ContinuationState,
  type ContinuationConnection,
  type ContinuationPending,
  type ContinuationDeferred
} from "./continuation-state";

export { AbortRegistry } from "./abort-registry";

export {
  applyToolUpdate,
  toolResultUpdate,
  crossMessageToolResultUpdate,
  toolApprovalUpdate,
  pausedExecutionUpdate,
  type ToolPartUpdate
} from "./tool-state";

export { parseProtocolMessage, type ChatProtocolEvent } from "./parse-protocol";

export {
  reconcileMessages,
  resolveToolMergeId,
  assistantContentKey
} from "./message-reconciler";

export {
  createChatFiberSnapshot,
  wrapChatFiberSnapshot,
  unwrapChatFiberSnapshot,
  type ChatFiberSnapshot
} from "./recovery";

/**
 * @internal Shared chat-recovery engine internals — sibling-package support for
 * `@cloudflare/ai-chat` and `@cloudflare/think`, not a public API. Re-exported
 * here only because both consumers import shared chat code through the
 * `agents/chat` entry point. See `design/rfc-chat-recovery-foundation.md`.
 */
export {
  evaluateChatRecoveryIncident,
  resolveChatRecoveryConfig,
  chatRecoveryIncidentId,
  chatRecoveryIncidentKey,
  selectStaleIncidentKeys,
  CHAT_RECOVERY_INCIDENT_KEY_PREFIX,
  CHAT_RECOVERY_PROGRESS_KEY,
  CHAT_RECOVERING_KEY,
  CHAT_LAST_TERMINAL_KEY,
  DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS,
  DEFAULT_CHAT_RECOVERY_MAX_WORK,
  DEFAULT_CHAT_RECOVERY_STABLE_TIMEOUT_MS,
  CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS,
  DEFAULT_CHAT_RECOVERY_TERMINAL_MESSAGE,
  CHAT_RECOVERY_INCIDENT_TTL_MS,
  KV_DELETE_MAX_KEYS,
  DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS,
  CHAT_RECOVERY_ALARM_DEBOUNCE_MS,
  CHAT_RECOVERING_FLAG_TTL_MS,
  type ChatRecoveryIncident,
  type ChatRecoveryKind,
  type ChatRecoveryIncidentEvent,
  type EvaluateChatRecoveryIncidentInput,
  type EvaluateChatRecoveryIncidentResult
} from "./recovery-incident";

export {
  chatRecoverySchedulePolicy,
  ChatRecoveryEngine,
  buildChatRecoveryExhaustedContext,
  notifyChatRecoveryExhausted,
  type ChatRecoveryScheduleReason,
  type ChatRecoveryScheduleCallback,
  type ChatRecoveryAdapter,
  type BeginChatRecoveryIncidentInput,
  type BeginChatRecoveryIncidentResult
} from "./recovery-engine";

export type {
  ChatResponseResult,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryProgressContext,
  ChatRecoveryOptions,
  ResolvedChatRecoveryConfig,
  MessageConcurrency,
  SaveMessagesOptions,
  SaveMessagesResult
} from "./lifecycle";
