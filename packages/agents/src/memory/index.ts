/**
 * Memory Primitives for Cloudflare Agents SDK
 *
 * This module provides structured memory primitives for building context-aware agents:
 * - Session: Durable, model-agnostic conversation state (ground truth)
 * - Working Context: Ephemeral, computed view for LLM invocations
 * - Events: Strongly-typed interaction records
 *
 * Based on tiered memory architecture principles from Google's ADK whitepaper.
 */

export {
  EventAction,
  type BaseEvent,
  type UserMessageEvent,
  type AgentMessageEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type ErrorEvent,
  type ControlSignalEvent,
  type CompactionEvent,
  type AgentTransferEvent,
  type SystemInstructionEvent,
  type Event,
  generateEventId
} from "./events";

export {
  Session,
  type SessionMetadata,
  type SessionStatistics,
  type CompactionConfig,
  type ConversationTurn
} from "./session";

export {
  WorkingContext,
  type ContentRole,
  type Content,
  type AgentIdentity,
  type ArtifactReference,
  type WorkingContextMetadata,
  type ContextWindowConfig
} from "./working-context";

export {
  // Processor types
  type RequestProcessor,
  type ResponseProcessor,
  type ProcessorEntry,
  type ProcessorPipelineConfig,
  // Pipeline class
  ProcessorPipeline,
  // Built-in request processors
  basicRequestProcessor,
  instructionsRequestProcessor,
  identityRequestProcessor,
  contentsRequestProcessor,
  slidingWindowRequestProcessor,
  compactionFilterRequestProcessor,
  contextCacheRequestProcessor,
  tokenLimitRequestProcessor,
  // Built-in response processors
  statisticsResponseProcessor,
  // Factory
  createDefaultPipeline,
  // Config types
  type InstructionsProcessorConfig,
  type ContentsProcessorConfig,
  type SlidingWindowProcessorConfig,
  type CompactionFilterProcessorConfig,
  type ContextCacheProcessorConfig,
  type DefaultPipelineOptions
} from "./processors";
