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
  ROW_MAX_BYTES,
  type EnforceRowSizeLimitOptions
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

export {
  ResumableStream,
  cleanupStreamBuffers,
  STREAM_CLEANUP_DELAY_SECONDS,
  type SqlTaggedTemplate
} from "./resumable-stream";

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
  hasIncompleteToolBatch,
  partAwaitsClientInteraction,
  clientResolvableToolNames,
  type ToolPartUpdate
} from "./tool-state";

export { parseProtocolMessage, type ChatProtocolEvent } from "./parse-protocol";

export {
  reconcileMessages,
  resolveToolMergeId,
  reconcileOrphanPartial
} from "./message-reconciler";

export type { OrphanPersistStore } from "./orphan-store";

export { sendIfOpen, type ChatConnection } from "./connection";

export {
  createChatFiberSnapshot,
  wrapChatFiberSnapshot,
  unwrapChatFiberSnapshot,
  type ChatFiberSnapshot,
  type SnapshotMessage
} from "./recovery";

/**
 * @internal Shared chat-recovery engine internals — sibling-package support for
 * `@cloudflare/ai-chat` and `@cloudflare/think` (and the experimental
 * `tanstack-recovery` / `pi-recovery` adapters), not a public API. Everything in
 * the five blocks below (`recovery-codec`, `resume-handshake`,
 * `recovery-incident`, `recovery-engine`, `stall-watchdog`) is `@internal`:
 * re-exported here only because those consumers import shared chat code through
 * the `agents/chat` entry point, never from the `agents` package root. See
 * `design/rfc-chat-recovery-foundation.md`.
 */
export {
  aiSdkRecoveryCodec,
  shouldCreditStreamProgress,
  type ChatRecoveryCodec,
  type ProgressCreditThrottle
} from "./recovery-codec";

export {
  ResumeHandshake,
  type ResumeHandshakeHost,
  type PendingChatTerminal
} from "./resume-handshake";

export {
  resolveChatRecoveryConfig,
  sweepStaleChatRecoveryIncidents,
  readChatRecoveryProgress,
  bumpChatRecoveryProgress,
  recordChatTerminal,
  clearChatTerminal,
  pendingChatTerminal,
  buildChatRecoveringFrame,
  setChatRecovering,
  AgentToolStreamProgressThrottle,
  AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS,
  StreamProgressCreditThrottle,
  CHAT_STREAM_PROGRESS_CREDIT_THROTTLE_MS,
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
  type ChatTerminalRecord,
  type ChatRecoveryIncident,
  type ChatRecoveryKind,
  type ChatRecoveryIncidentEvent,
  type EvaluateChatRecoveryIncidentInput,
  type EvaluateChatRecoveryIncidentResult
} from "./recovery-incident";

export {
  chatRecoverySchedulePolicy,
  ChatRecoveryEngine,
  runChatRecoveryExhaustion,
  type ChatRecoveryScheduleReason,
  type ChatRecoveryScheduleCallback,
  type ChatRecoveryAdapter,
  type ChatFiberWakeHooks,
  type ChatStreamStatus,
  type ResolvedRecoveryStream,
  type ClassifyRecoveredTurnInput,
  type InvokeOnChatRecoveryInput,
  type PersistOrphanedPartialInput,
  type DispatchRecoveredTurnInput,
  type RecoveryPartial,
  type BeginChatRecoveryIncidentInput,
  type BeginChatRecoveryIncidentResult
} from "./recovery-engine";

export {
  ChatStreamStalledError,
  iterateWithStallWatchdog
} from "./stall-watchdog";

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
