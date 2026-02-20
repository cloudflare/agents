/**
 * @experimental Memory primitives utilities — unstable, may change without notice.
 *
 * Pure functions for converting between storage rows, application events, and context messages.
 * These functions have NO SQL dependency and are safe to use anywhere (Agent, Workflow, Worker).
 */

import {
  EventAction,
  type ContextMessage,
  type SessionEvent,
  type StoredEvent,
  type ToolCall
} from "./types";

// ---------------------------------------------------------------------------
// StoredEvent ↔ SessionEvent
// ---------------------------------------------------------------------------

/**
 * @experimental
 * Convert a raw SQL row into a typed SessionEvent.
 */
export function hydrateEvent(row: StoredEvent): SessionEvent {
  const base = {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    timestamp: row.created_at
  };

  const meta: Record<string, unknown> = row.metadata
    ? JSON.parse(row.metadata)
    : {};

  switch (row.action) {
    case EventAction.USER_MESSAGE:
      return {
        ...base,
        action: EventAction.USER_MESSAGE,
        content: row.content ?? ""
      };

    case EventAction.AGENT_MESSAGE:
      return {
        ...base,
        action: EventAction.AGENT_MESSAGE,
        content: row.content ?? "",
        model: meta.model as string | undefined
      };

    case EventAction.TOOL_CALL_REQUEST:
      return {
        ...base,
        action: EventAction.TOOL_CALL_REQUEST,
        content: row.content ?? "",
        toolCalls: (meta.toolCalls as ToolCall[]) ?? []
      };

    case EventAction.TOOL_RESULT:
      return {
        ...base,
        action: EventAction.TOOL_RESULT,
        content: row.content ?? "",
        toolCallId: meta.toolCallId as string,
        toolName: meta.toolName as string,
        isSuccess: (meta.isSuccess as boolean) ?? true
      };

    case EventAction.SYSTEM_INSTRUCTION:
      return {
        ...base,
        action: EventAction.SYSTEM_INSTRUCTION,
        content: row.content ?? ""
      };

    case EventAction.COMPACTION:
      return {
        ...base,
        action: EventAction.COMPACTION,
        content: row.content ?? "",
        compactedEventCount: (meta.compactedEventCount as number) ?? 0
      };

    default:
      // Treat unknown actions as user messages to avoid data loss
      return {
        ...base,
        action: EventAction.USER_MESSAGE,
        content: row.content ?? ""
      };
  }
}

/**
 * @experimental
 * Convert a typed SessionEvent into a raw SQL row for INSERT.
 * The `seq` field must be set by the caller (appendEvents computes it).
 */
export function dehydrateEvent(event: SessionEvent): StoredEvent {
  const base: Pick<
    StoredEvent,
    "id" | "session_id" | "seq" | "action" | "created_at"
  > = {
    id: event.id,
    session_id: event.sessionId,
    seq: event.seq,
    action: event.action,
    created_at: event.timestamp
  };

  switch (event.action) {
    case EventAction.USER_MESSAGE:
      return { ...base, content: event.content, metadata: null };

    case EventAction.AGENT_MESSAGE:
      return {
        ...base,
        content: event.content,
        metadata: event.model ? JSON.stringify({ model: event.model }) : null
      };

    case EventAction.TOOL_CALL_REQUEST:
      return {
        ...base,
        content: event.content,
        metadata: JSON.stringify({ toolCalls: event.toolCalls })
      };

    case EventAction.TOOL_RESULT:
      return {
        ...base,
        content: event.content,
        metadata: JSON.stringify({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isSuccess: event.isSuccess
        })
      };

    case EventAction.SYSTEM_INSTRUCTION:
      return { ...base, content: event.content, metadata: null };

    case EventAction.COMPACTION:
      return {
        ...base,
        content: event.content,
        metadata: JSON.stringify({
          compactedEventCount: event.compactedEventCount
        })
      };

    default:
      return {
        ...base,
        content: (event as SessionEvent).content,
        metadata: null
      };
  }
}

// ---------------------------------------------------------------------------
// SessionEvent ↔ ContextMessage
// ---------------------------------------------------------------------------

/**
 * @experimental
 * Convert a SessionEvent into a ContextMessage for use in WorkingContext.
 * Returns null for events that should not appear in the LLM conversation (e.g., compaction summaries can be mapped as system messages if desired).
 */
export function eventToMessage(event: SessionEvent): ContextMessage | null {
  switch (event.action) {
    case EventAction.USER_MESSAGE:
      return { role: "user", content: event.content };

    case EventAction.AGENT_MESSAGE:
      return { role: "assistant", content: event.content };

    case EventAction.TOOL_CALL_REQUEST:
      return {
        role: "assistant",
        content: event.content,
        toolCalls: event.toolCalls
      };

    case EventAction.TOOL_RESULT:
      return {
        role: "tool",
        content: event.content,
        toolCallId: event.toolCallId,
        name: event.toolName
      };

    case EventAction.SYSTEM_INSTRUCTION:
      return { role: "system", content: event.content };

    case EventAction.COMPACTION:
      // Include compaction summaries as system context
      return { role: "system", content: event.content };

    default:
      return null;
  }
}

/**
 * @experimental
 * Convert a ContextMessage into a SessionEvent.
 * Caller must provide sessionId. `id`, `seq`, and `timestamp` are generated here.
 * `seq` is set to 0 as a placeholder — the actual seq is assigned by appendEvents.
 */
export function messageToEvent(
  sessionId: string,
  msg: ContextMessage
): SessionEvent {
  const base = {
    id: crypto.randomUUID(),
    sessionId,
    seq: 0, // placeholder — assigned by appendEvents
    timestamp: Date.now()
  };

  if (msg.role === "user") {
    return { ...base, action: EventAction.USER_MESSAGE, content: msg.content };
  }
  // TOOL_CALL_REQUEST are also stored as 'assistant' messages, eventhough it is a separate event, hence this extra check
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      ...base,
      action: EventAction.TOOL_CALL_REQUEST,
      content: msg.content,
      toolCalls: msg.toolCalls
    };
  }

  if (msg.role === "assistant") {
    return { ...base, action: EventAction.AGENT_MESSAGE, content: msg.content };
  }

  if (msg.role === "tool") {
    return {
      ...base,
      action: EventAction.TOOL_RESULT,
      content: msg.content,
      toolCallId: msg.toolCallId ?? "",
      toolName: msg.name ?? "",
      isSuccess: true
    };
  }

  if (msg.role === "system") {
    return {
      ...base,
      action: EventAction.SYSTEM_INSTRUCTION,
      content: msg.content
    };
  }

  // Fallback
  return { ...base, action: EventAction.USER_MESSAGE, content: msg.content };
}
