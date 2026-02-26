/**
 * @experimental Memory primitives types — unstable, may change without notice.
 *
 * Core type definitions for the session/event/context system.
 */

// ---------------------------------------------------------------------------
// Event Actions
// ---------------------------------------------------------------------------

/**
 * @experimental
 * Discriminator for event types stored in cf_agents_events.
 */
export const EventAction = {
  USER_MESSAGE: "user_message",
  AGENT_MESSAGE: "agent_message",
  TOOL_CALL_REQUEST: "tool_call_request",
  TOOL_RESULT: "tool_result",
  SYSTEM_INSTRUCTION: "system_instruction",
  COMPACTION: "compaction"
} as const;

export type EventActionType = (typeof EventAction)[keyof typeof EventAction];

// ---------------------------------------------------------------------------
// Stored row shapes (what lives in SQLite)
// ---------------------------------------------------------------------------

/**
 * @experimental
 * Raw row shape for cf_agents_sessions.
 */
export interface StoredSession {
  id: string;
  agent_id: string;
  created_at: number; // ms since epoch
  updated_at: number; // ms since epoch
  metadata: string | null; // JSON
}

/**
 * @experimental
 * Raw row shape for cf_agents_events.
 */
export interface StoredEvent {
  id: string;
  session_id: string;
  seq: number;
  action: string;
  content: string | null;
  metadata: string | null; // JSON
  created_at: number; // ms since epoch
}

// ---------------------------------------------------------------------------
// Application-level types (hydrated from StoredEvent)
// ---------------------------------------------------------------------------

/**
 * @experimental
 * Base fields shared by all session events.
 */
interface BaseEvent {
  id: string;
  sessionId: string;
  seq: number;
  timestamp: number; // ms since epoch
}

/**
 * @experimental
 * Discriminated union of all session event types.
 */
export type SessionEvent =
  | (BaseEvent & {
      action: typeof EventAction.USER_MESSAGE;
      content: string;
    })
  | (BaseEvent & {
      action: typeof EventAction.AGENT_MESSAGE;
      content: string;
      model?: string;
    })
  | (BaseEvent & {
      action: typeof EventAction.TOOL_CALL_REQUEST;
      content: string;
      toolCalls: ToolCall[];
    })
  | (BaseEvent & {
      action: typeof EventAction.TOOL_RESULT;
      content: string;
      toolCallId: string;
      toolName: string;
      isSuccess: boolean;
    })
  | (BaseEvent & {
      action: typeof EventAction.SYSTEM_INSTRUCTION;
      content: string;
    })
  | (BaseEvent & {
      action: typeof EventAction.COMPACTION;
      content: string;
      compactedEventCount: number;
    });

// ---------------------------------------------------------------------------
// Tool call structure
// ---------------------------------------------------------------------------

/**
 * @experimental
 * Structured tool call — preserved through storage→load→adapter roundtrips.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Context message (common format for WorkingContext)
// ---------------------------------------------------------------------------

/**
 * @experimental
 * Common message format used in WorkingContext.
 * Intentionally similar to the OpenAI/Anthropic/Workers AI messages format.
 */
export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Options / config interfaces
// ---------------------------------------------------------------------------

/**
 * @experimental
 * Options for loading events from the session store.
 */
export interface LoadEventsOptions {
  /** Maximum number of events to return (default: 50). */
  limit?: number;
  /** Only return events created after this timestamp (ms since epoch). */
  since?: number;
  /** Filter by specific event action types. */
  actions?: EventActionType[];
  /**
   * When true (the default), load the LAST N events ordered by seq ASC.
   * When false, load the FIRST N events ordered by seq ASC.
   *
   * Default is `true` because context-building typically needs the most recent
   * events. Set to `false` for replay/migration/export scenarios.
   */
  tail?: boolean;
}

/**
 * @experimental
 * Options for building a WorkingContext from events.
 */
export interface ContextBuilderOptions {
  /** System instructions prepended to the context. */
  systemInstructions?: string[];
  /** Maximum number of events to load from SQL (default: 50). */
  limit?: number;
  /** Only include events after this timestamp (ms since epoch). */
  since?: number;
  /** Filter by specific event action types. */
  actions?: EventActionType[];
  /** Load last N events (default: true). Set false for first N. */
  tail?: boolean;
  /** Custom callback to override how events map to messages. Return null to skip an event. */
  eventToMessage?: (event: SessionEvent) => ContextMessage | null;
}

/**
 * @experimental
 * Model format adapter — stateless function that converts WorkingContext to provider-specific input.
 */
export interface ModelFormatAdapter<T = unknown> {
  name: string;
  toModelMessages(systemInstructions: string[], messages: ContextMessage[]): T;
}
