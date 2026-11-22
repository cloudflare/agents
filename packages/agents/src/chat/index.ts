export {
  applyChunkToParts,
  applyLateToolInput,
  isLateToolInputChunk,
  isReplayChunk,
  lateToolInputForwardChunks,
  normalizeToolInput,
  settleInterruptedPart,
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

export { originMessageIds, withOriginMessageIds } from "./origin-message-ids";

export {
  mergeQueuedUserMessages,
  mergeUserMessages
} from "./merge-user-messages";

export {
  PROVIDER_TOOL_MAX_STRING_LENGTH,
  truncateProviderToolPayloads
} from "./provider-tool-payloads";

/**
 * @internal Shared text-segment separator for sibling streaming packages.
 */
export {
  TextSegmentJoiner,
  type TextSegmentChunk,
  type TextSegmentEvent
} from "./text-segment-joiner";

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
  createChatStreams,
  type SqlTaggedTemplate
} from "./resumable-stream";
export {
  createChatTurnTaskDefinition,
  type ChatTurnClosureEntry,
  type ChatTurnTaskHooks
} from "./turn-task";

/**
 * @internal Durable admission of client requests, for `AIChatAgent` and
 * `Think`. Not a public API. See `admissions.ts`.
 */
export {
  CHAT_ADMISSIONS_TABLE,
  ChatAdmissions,
  chatRecoveryNames,
  createChatAdmissionStore,
  newUserMessageIds,
  type ChatAdmissionRecord,
  type ChatAdmissionStore,
  type ChatAdmissionsHost,
  type HeldChatMessage,
  type StoredSubmitDecision
} from "./admissions";

/**
 * @internal Running one chat turn as a durable fiber, for `AIChatAgent` and
 * `Think`. Not a public API. See `turn-fiber.ts`.
 */
export {
  ChatTurnFibers,
  type ChatTurnFiber,
  type ChatTurnFiberHost
} from "./turn-fiber";
export {
  CHAT_RECOVERY_TASK_NAME,
  chatRecoveryTaskRunOptions,
  createChatRecoveryTaskDefinition,
  dispatchChatRecoveryToHandoff,
  enqueueChatRecoveryTask,
  type ChatRecoveryHandoff,
  type ChatRecoveryTaskHooks,
  type ChatRecoveryTaskInput,
  type ChatRecoveryTaskReason
} from "./recovery-task";

export { MAX_BOUND_PARAMS, buildInClauseStrings } from "./sql-batch";

/**
 * @internal Platform-failure classifier shared with the chat hosts'
 * queue-dispatch deferral (#1730); sibling-package support, not a public API.
 */
export { isPlatformFailure, isDurableObjectResetError } from "../retries";

export {
  createToolsFromClientSchemas,
  type ClientToolSchema,
  type ClientToolExecutor
} from "./client-tools";

export {
  CHAT_MESSAGE_TYPES,
  STREAM_RESUME_NONE_REASONS,
  type StreamResumeNoneReason
} from "./protocol";

export { MessageType } from "./wire-types";
export type {
  ChatTurnOutcome,
  OutgoingMessage,
  IncomingMessage
} from "./wire-types";

export {
  applyAgentToolEvent,
  createAgentToolEventState,
  interceptAgentToolBroadcast,
  isPositionlessAgentToolChunk,
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
  addContinuationTarget,
  continuationTargetIsLatest,
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
  type ContinuationSource,
  type ContinuationSpec,
  type ToolInteractionOutcome
} from "./auto-continuation-controller";

/**
 * @internal The auto-continuation turn's lifecycle, from fire to settle.
 * `ChatTurns` exposes each function as a method. Not a public API. See
 * `continuation-turn.ts`.
 */
export {
  continuationStreamEnded,
  continuationStreamStarted,
  dropWaitingContinuations,
  replyFinalized,
  runContinuationTurn,
  settleContinuationTurn,
  transcriptEndsInAnswer,
  type ContinuationContext,
  type ContinuationDropped,
  type ContinuationTurn,
  type ContinuationTurnParts
} from "./continuation-turn";

/**
 * @internal The report of a turn that failed before it streamed, for a
 * client request and a continuation. Not a public API. See
 * `turn-failure.ts`.
 */
export {
  reportTurnFailure,
  type TurnErrorFrame,
  type TurnFailure,
  type TurnFailureHost,
  type TurnFailureResult
} from "./turn-failure";

/**
 * @internal The turn core shared by `@cloudflare/ai-chat` and
 * `@cloudflare/think`: the turn queue, abort registry, submit concurrency,
 * continuation slots and barrier, pre-stream set and tool-result apply chain,
 * with the rules that tie them together. Not a public API. See
 * `chat-turns.ts` and `design/chat-turn-core.md`.
 */
export {
  ChatTurns,
  type ChatTurnsHost,
  type ChatTurnsOptions,
  type ChatTurnsAdmissionOptions,
  type ChatTurnMessage,
  type ClientChatRequest,
  type RecoveryAttemptHandle
} from "./chat-turns";

/**
 * @internal A turn the server starts itself (`saveMessages`,
 * `continueLastTurn`, a retry), run through `ChatTurns.runServerTurn`. Not a
 * public API. See `server-turn.ts`.
 */
export {
  runServerTurn,
  mapServerTurnOutcome,
  pinnedOr,
  prepareTurnMessages,
  toSaveMessagesResult,
  type PinnedTurnContext,
  type ServerChatTurn,
  type ServerTurnOutcome,
  type ServerTurnParts,
  type ServerTurnPrepared,
  type ServerTurnStatus
} from "./server-turn";

/**
 * @internal The life of an agent-tool run on the child agent, shared by
 * `@cloudflare/ai-chat` and `@cloudflare/think`: start, the bound request
 * id, cancel, the terminal status, and the reconcile of a run an earlier
 * isolate started. Not a public API. See `agent-tool-runs.ts`.
 */
export {
  AgentToolRuns,
  abortReasonText,
  agentToolRunOutcome,
  isAgentToolRunOpen,
  type AgentToolRunsHost,
  type AgentToolStreams,
  type AgentToolTurnResult
} from "./agent-tool-runs";
export {
  createAgentToolRunStore,
  type AgentToolRunRecord,
  type AgentToolRunStore,
  type AgentToolRunTerminal,
  type AgentToolSql,
  type AgentToolTableNames
} from "./agent-tool-run-store";

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
  hasPendingToolInteraction,
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

export { keepStoredReplies } from "./stored-replies";

/**
 * @internal Shared transcript-repair primitive — flips interrupted tool calls
 * to a settled shape so a recovered turn's next provider call doesn't 400 with
 * `AI_MissingToolResultsError`. Sibling-package support for `@cloudflare/think`
 * and `@cloudflare/ai-chat`, not a public API. See `repair-transcript.ts`.
 */
export {
  persistRepairedTranscript,
  removeEmptyReplyToContinue,
  repairInterruptedToolParts,
  replyIsEmpty,
  settleInterruptedReply,
  settleReplyBeforeRecovery,
  streamChunksFinished,
  stripTrailingReasoning,
  toolPartHasSettledResult,
  unsettledToolCallIds,
  type RepairedTranscriptSink,
  type ReplyRemoval,
  type RepairInterruptedToolPartsOptions,
  type RepairInterruptedToolPartsResult,
  type SettleInterruptedReplyOptions
} from "./repair-transcript";

/**
 * @internal What a turn settles before the model is called: the request
 * context a client request stores, and the before-turn transcript repair.
 * Sibling-package support, not a public API. See `before-turn.ts`.
 */
export {
  continuationWaitsOnClient,
  replyToContinueIsEmpty,
  interruptedToolPartAsError,
  INTERRUPTED_TOOL_ERROR_TEXT,
  repairTranscriptBeforeTurn,
  type BeforeTurnRepairOptions,
  type BeforeTurnRepairResult
} from "./before-turn";

/**
 * @internal The one owner of a chat's stored request context (client tools
 * and body). Sibling-package support, not a public API. See
 * `request-context.ts`.
 */
export {
  ChatRequestContext,
  clientRequestContext,
  type ClientRequestContext,
  type RequestContextKey,
  type RequestContextStore
} from "./request-context";

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
  chunkCarriesContent,
  chunkMustBeStoredNow,
  takeAtFirstContent,
  partialHasSettledToolResults,
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
  listActiveChatRecoveryIncidents,
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
  DEFAULT_CHAT_RECOVERY_MAX_INTERRUPTED_ATTEMPTS,
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
  type ChatRecoveryTrigger,
  type ChatRecoveryAttempt,
  type ChatRecoveryIncidentEvent,
  type EvaluateChatRecoveryIncidentInput,
  type EvaluateChatRecoveryIncidentResult
} from "./recovery-incident";

export {
  ChatRecoveryEngine,
  runChatRecoveryExhaustion,
  chatRecoveryBackoffSeconds,
  retryAfterSeconds,
  CHAT_RECOVERY_CANCELLED_REASON,
  CHAT_RECOVERY_CONTINUED_REASON,
  chatRecoveryProgressReader,
  chatRecoveryStorageAdapter,
  type ChatRecoveryTurnBindings,
  type ChatRecoveryAttemptScope,
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
  routeStreamInterruption,
  scheduleRecoveredTurn,
  type RecoveredTurnSchedule,
  type StreamInterruptionHost,
  type StreamInterruptionOutcome,
  type StreamInterruptionRecoveryContext
} from "./recovery-route";

export {
  runRecoveredTurn,
  handleRecoveryAttemptError,
  cutOffReplyToSettle,
  type RecoveredTurnHost,
  type RecoveredTurnResult,
  type RecoveryAttemptData,
  type RecoveryLeafCheck
} from "./recovery-attempt";

export {
  ChatStreamStalledError,
  iterateWithStallWatchdog
} from "./stall-watchdog";

export { ChatRecoverySupersededError, isTurnStopped } from "./turn-stop";

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
  SaveMessagesResult,
  AbortedTurnReason,
  SkippedTurnReason
} from "./lifecycle";
export {
  truncateOlderMessages,
  truncateOlderToolResults,
  type TruncateOptions,
  type TruncateToolResultsOptions
} from "./truncate-older-messages";

export {
  clearRecentChatTerminals,
  recentChatTerminal,
  recordRecentChatTerminal,
  RECENT_TERMINALS_MAX,
  type ChatRecentTerminal,
  type RecentTerminalsKv
} from "./recent-terminals";
