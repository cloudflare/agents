/**
 * Pi's harness events, projected onto the shared harness vocabulary.
 *
 * Anything the core event bodies already name (messages, tool calls, usage,
 * faults) becomes a `HarnessCoreEvent`, so every harness renders the same
 * way; token deltas become previews, which are live-only and never
 * persisted; everything that is pi's own becomes an `extension` frame typed
 * by {@link PiEvent}.
 */
import type {
  AgentToolResult,
  HarnessEvent,
  HarnessEventType
} from "@earendil-works/pi-agent-core";
import type {
  HarnessCoreEvent,
  HarnessPreviewBody,
  HarnessUsage,
  JsonValue
} from "@cloudflare/agents-next-harness";
import {
  projectAgentMessage,
  projectEntry,
  projectQueue,
  projectToolResult,
  toSessionParts
} from "./messages";
import type { PiEvent, PiJson, PiProtocol } from "./types";

/** Harness event types the runtime subscribes to. */
export const SUBSCRIBED_EVENT_TYPES = [
  "run_resume",
  "run_suspend",
  "operation_abort",
  "retry_scheduled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "entry_added",
  "queue_update",
  "config_update",
  "compaction_start",
  "compaction_end",
  "navigation_start",
  "navigation_end",
  "usage",
  "fault"
] as const satisfies readonly HarnessEventType[];

/** Where one projected event goes: the durable log, or a live preview. */
export type ProjectedPiEvent = {
  /** The operation pi attributes the event to, when it names one. */
  readonly operationId?: string;
} & (
  | { readonly kind: "core"; readonly body: HarnessCoreEvent }
  | { readonly kind: "preview"; readonly body: HarnessPreviewBody }
  | { readonly kind: "extension"; readonly body: PiProtocol["event"] }
);

/** The id previews and the enclosing message frames share while streaming. */
function streamingMessageId(runId: string): string {
  return `pending:${runId}`;
}

function extension(event: PiEvent, operationId?: string): ProjectedPiEvent {
  return {
    kind: "extension",
    ...(operationId === undefined ? {} : { operationId }),
    // SAFETY: PiEvent is plain JSON; the wire type differs only in widening
    // readonly arrays, which `JsonValue` does not accept.
    body: event as PiProtocol["event"]
  };
}

/** A tool result as one JSON value: its text, plus whatever details it kept. */
function toolOutput(result: AgentToolResult<unknown>): JsonValue {
  const projected = projectToolResult(result);
  return {
    text: projected.content
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n"),
    ...(projected.details === undefined
      ? {}
      : { details: projected.details as JsonValue })
  };
}

/**
 * Project one pi harness event. `undefined` means the event has no harness
 * projection: the base writes operation start and settlement itself, and
 * pi's incremental tool-call frames are covered by `tool_start`.
 */
export function projectPiEvent(
  event: HarnessEvent
): ProjectedPiEvent | undefined {
  switch (event.type) {
    case "run_resume":
      return extension(
        { type: "operation_resume", operationId: event.runId },
        event.runId
      );
    case "run_suspend":
      return extension(
        {
          type: "operation_wait",
          operationId: event.runId,
          reason: "deferred",
          deferred: event.deferred
        },
        event.runId
      );
    case "operation_abort":
      return extension(
        { type: "operation_abort", operationId: event.operationId },
        event.operationId
      );
    case "retry_scheduled":
      return extension(
        {
          type: "operation_wait",
          operationId: event.runId,
          reason: "retry",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          notBefore: event.notBefore,
          message: event.errorMessage
        },
        event.runId
      );
    case "turn_start":
      return extension(
        { type: "turn_start", operationId: event.runId, turnId: event.turnId },
        event.runId
      );
    case "turn_end":
      return extension(
        { type: "turn_end", operationId: event.runId, turnId: event.turnId },
        event.runId
      );
    case "message_start": {
      const messageId =
        event.runId === undefined ? "pending" : streamingMessageId(event.runId);
      const message = projectAgentMessage(event.message, messageId);
      if (!message) return undefined;
      return {
        ...(event.runId === undefined ? {} : { operationId: event.runId }),
        kind: "core",
        body: { type: "message_start", messageId, role: message.role }
      };
    }
    case "message_update": {
      const frame = event.frame;
      if (!frame) return undefined;
      const messageId = streamingMessageId(event.runId);
      if (frame.type === "text_delta") {
        return {
          operationId: event.runId,
          kind: "preview",
          body: { type: "text_delta", messageId, delta: frame.delta }
        };
      }
      if (frame.type === "thinking_delta") {
        return {
          operationId: event.runId,
          kind: "preview",
          body: { type: "reasoning_delta", messageId, delta: frame.delta }
        };
      }
      return undefined;
    }
    case "message_end": {
      const messageId =
        event.runId === undefined
          ? (event.entryId ?? "pending")
          : streamingMessageId(event.runId);
      const message = projectAgentMessage(event.message, messageId);
      if (!message) return undefined;
      return {
        ...(event.runId === undefined ? {} : { operationId: event.runId }),
        kind: "core",
        body: {
          type: "message_end",
          messageId,
          role: message.role,
          parts: toSessionParts(message.parts)
        }
      };
    }
    case "tool_start":
      return {
        operationId: event.runId,
        kind: "core",
        body: {
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          // SAFETY: pi validated these arguments against the tool schema.
          input: event.args as JsonValue
        }
      };
    case "tool_update":
      return extension(
        {
          type: "tool_update",
          operationId: event.runId,
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partial: projectToolResult(event.partialResult)
        },
        event.runId
      );
    case "tool_end":
      return {
        operationId: event.runId,
        kind: "core",
        body: {
          type: "tool_end",
          toolCallId: event.toolCallId,
          output: toolOutput(event.result),
          isError: event.isError
        }
      };
    case "entry_added": {
      switch (event.entry.type) {
        case "message": {
          const message = projectEntry(event.entry);
          return message ? extension({ type: "message", message }) : undefined;
        }
        case "compaction":
          return extension({
            type: "transcript_reset",
            reason: "compaction"
          });
        case "branch_summary":
          return extension({
            type: "transcript_reset",
            reason: "navigation"
          });
        default:
          return undefined;
      }
    }
    case "queue_update":
      return extension({
        type: "queue_update",
        queue: projectQueue(event.queues)
      });
    case "config_update":
      if (
        event.property !== "model" &&
        event.property !== "thinkingLevel" &&
        event.property !== "activeTools"
      ) {
        return undefined;
      }
      return extension({
        type: "config_update",
        property: event.property,
        // SAFETY: lane configuration values are JSON pi persisted.
        value: event.value as PiJson
      });
    case "compaction_start":
      return extension(
        {
          type: "compaction_start",
          operationId: event.runId,
          reason: event.reason
        },
        event.runId
      );
    case "compaction_end":
      return extension(
        {
          type: "compaction_end",
          operationId: event.runId,
          reason: event.reason,
          status: event.status
        },
        event.runId
      );
    case "navigation_start":
      return extension(
        {
          type: "navigation_start",
          operationId: event.runId,
          targetId: event.targetId
        },
        event.runId
      );
    case "navigation_end":
      return extension(
        {
          type: "navigation_end",
          operationId: event.runId,
          status: event.status
        },
        event.runId
      );
    case "usage":
      return {
        kind: "core",
        body: { type: "usage", usage: toHarnessUsage(event.totals) }
      };
    case "fault":
      return {
        kind: "core",
        body: {
          type: "error",
          error: { code: event.code, message: event.message }
        }
      };
    default:
      return undefined;
  }
}

/** Pi's usage totals in the shared shape. */
export function toHarnessUsage(usage: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly cost: { readonly total: number };
}): HarnessUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    ...(usage.reasoning === undefined
      ? {}
      : { reasoningTokens: usage.reasoning }),
    costUsd: usage.cost.total
  };
}
