/**
 * Event Types and Interfaces
 *
 * Strongly-typed, model-agnostic event records for agent interactions.
 * Events are the atomic units of the conversation history.
 */

// ============================================================================
// EVENT TYPES - Structured, language-agnostic history
// ============================================================================

/**
 * Event action types representing all possible interactions in the system
 */
export enum EventAction {
  USER_MESSAGE = "user_message",
  AGENT_MESSAGE = "agent_message",
  TOOL_CALL = "tool_call",
  TOOL_RESULT = "tool_result",
  ERROR = "error",
  CONTROL_SIGNAL = "control_signal",
  COMPACTION = "compaction",
  AGENT_TRANSFER = "agent_transfer",
  SYSTEM_INSTRUCTION = "system_instruction"
}

/**
 * Base event structure - all events extend this
 */
export interface BaseEvent {
  id: string;
  action: EventAction;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * User message event
 */
export interface UserMessageEvent extends BaseEvent {
  action: EventAction.USER_MESSAGE;
  content: string;
  customParams?: Record<string, unknown>;
}

/**
 * Agent message event
 */
export interface AgentMessageEvent extends BaseEvent {
  action: EventAction.AGENT_MESSAGE;
  content: string;
  agentId: string;
  modelUsed?: string;
  tokensUsed?: number;
  gatewayLogId?: string;
  customParams?: Record<string, unknown>;
}

/**
 * Tool call event
 */
export interface ToolCallEvent extends BaseEvent {
  action: EventAction.TOOL_CALL;
  toolName: string;
  arguments: Record<string, unknown>;
  toolCallId: string;
  serverId?: string;
  customParams?: Record<string, unknown>;
}

/**
 * Tool result event
 */
export interface ToolResultEvent extends BaseEvent {
  action: EventAction.TOOL_RESULT;
  toolCallId: string;
  toolName: string;
  result: string | object;
  isSuccess: boolean;
  executionTimeMs?: number;
  customParams?: Record<string, unknown>;
}

/**
 * Error event
 */
export interface ErrorEvent extends BaseEvent {
  action: EventAction.ERROR;
  errorType: string;
  errorMessage: string;
  errorStack?: string;
  recoverable: boolean;
}

/**
 * Control signal event (e.g., context reset, agent handoff)
 */
export interface ControlSignalEvent extends BaseEvent {
  action: EventAction.CONTROL_SIGNAL;
  signalType: "reset" | "handoff" | "pause" | "resume";
  payload?: Record<string, unknown>;
}

/**
 * Compaction event - result of context summarization
 */
export interface CompactionEvent extends BaseEvent {
  action: EventAction.COMPACTION;
  summary: string;
  compactedEventIds: string[];
  compactionStrategy: "sliding_window" | "semantic" | "time_based";
  originalTokenCount?: number;
  compactedTokenCount?: number;
  customParams?: Record<string, unknown>;
}

/**
 * Agent transfer event
 */
export interface AgentTransferEvent extends BaseEvent {
  action: EventAction.AGENT_TRANSFER;
  fromAgent: string;
  toAgent: string;
  transferReason: string;
  scopedContext?: string[];
}

/**
 * System instruction event
 */
export interface SystemInstructionEvent extends BaseEvent {
  action: EventAction.SYSTEM_INSTRUCTION;
  instruction: string;
  isStatic: boolean;
  customParams?: Record<string, unknown>;
}

/**
 * Union type of all events
 */
export type Event =
  | UserMessageEvent
  | AgentMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent
  | ControlSignalEvent
  | CompactionEvent
  | AgentTransferEvent
  | SystemInstructionEvent;

// ============================================================================
// EVENT UTILITIES
// ============================================================================

/**
 * Generate a unique event ID
 */
export function generateEventId(): string {
  return `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
