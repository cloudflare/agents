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

export { MessageType } from "./wire-types";
export type { OutgoingMessage, IncomingMessage } from "./wire-types";

export {
  applyAgentToolEvent,
  createAgentToolEventState,
  interceptAgentToolBroadcast,
  AgentToolProgressEmitter,
  type AgentToolProgressEmitHooks,
  type AgentToolProgressEmitResult,
  type AgentToolBroadcastHooks,
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

/**
 * @internal Shared pre-stream-turn tracker (#1784) — represents the window
 * between a turn being accepted and its resumable stream starting so a
 * reconnecting client keeps waiting instead of giving up. Sibling-package
 * support for `@cloudflare/ai-chat` and `@cloudflare/think`, not a public API.
 * See `pre-stream-turns.ts`.
 */
export { PreStreamTurns } from "./pre-stream-turns";

/**
 * @internal Shared auto-continuation barrier (the tool-result → auto-continue
 * flow, #1649 / #1650) — sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API. See `auto-continuation-controller.ts`.
 */
export {
  AutoContinuationController,
  type AutoContinuationHost,
  type ContinuationSpec
} from "./auto-continuation-controller";

export { AbortRegistry } from "./abort-registry";

/**
 * @internal Small async control-flow helpers shared by the chat hosts
 * (`@cloudflare/ai-chat` and `@cloudflare/think`), not a public API. See
 * `async-helpers.ts`.
 */
export {
  TIMED_OUT,
  awaitWithDeadline,
  drainInteractionApplies
} from "./async-helpers";

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

/**
 * @internal Shared transcript-repair primitive — flips interrupted tool calls
 * to a settled shape so a recovered turn's next provider call doesn't 400 with
 * `AI_MissingToolResultsError`. Sibling-package support for `@cloudflare/think`
 * and `@cloudflare/ai-chat`, not a public API. See `repair-transcript.ts`.
 */
export {
  repairInterruptedToolParts,
  toolPartHasSettledResult,
  type RepairInterruptedToolPartsOptions,
  type RepairInterruptedToolPartsResult
} from "./repair-transcript";

export type { OrphanPersistStore } from "./orphan-store";

/**
 * @internal Shared orphan-persist core — reconstruct an interrupted stream's
 * message and upsert it through an `OrphanPersistStore`. Sibling-package support
 * for `@cloudflare/think` and `@cloudflare/ai-chat`, not a public API. See
 * `orphan-persist.ts`.
 */
export {
  persistReconstructedOrphan,
  type PersistReconstructedOrphanOptions
} from "./orphan-persist";

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
  classifyAgentToolChildRecovery,
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
  ReplyAttachment,
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
