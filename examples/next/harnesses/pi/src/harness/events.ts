import type {
  HarnessEvent,
  HarnessEventType
} from "@earendil-works/pi-agent-core";
import type { StreamWriter } from "agents/streams";
import {
  projectAgentMessage,
  projectEntry,
  projectFrame,
  projectQueue,
  projectToolResult
} from "./messages";
import type { PiEvent, PiJson } from "./types";

/** Harness event types the capability subscribes to. */
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
  "fault"
] as const satisfies readonly HarnessEventType[];

/** A projected event with the operation it belongs to, when pi says. */
export type ProjectedEvent = {
  readonly event: PiEvent;
  readonly operationId?: string;
};

function streamingMessageId(runId: string): string {
  return `pending:${runId}`;
}

/**
 * Project one pi harness event into the public wire shape. Operation start
 * and end are not projected here: the harness synthesizes them from
 * admission and the settled result, which cover every operation kind.
 */
export function projectHarnessEvent(
  event: HarnessEvent
): ProjectedEvent | undefined {
  switch (event.type) {
    case "run_resume":
      return {
        operationId: event.runId,
        event: { type: "operation_resume", operationId: event.runId }
      };
    case "run_suspend":
      return {
        operationId: event.runId,
        event: {
          type: "operation_wait",
          operationId: event.runId,
          reason: "deferred",
          deferred: event.deferred
        }
      };
    case "operation_abort":
      return {
        operationId: event.operationId,
        event: { type: "operation_abort", operationId: event.operationId }
      };
    case "retry_scheduled":
      return {
        operationId: event.runId,
        event: {
          type: "operation_wait",
          operationId: event.runId,
          reason: "retry",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          notBefore: event.notBefore,
          message: event.errorMessage
        }
      };
    case "turn_start":
      return {
        operationId: event.runId,
        event: {
          type: "turn_start",
          operationId: event.runId,
          turnId: event.turnId
        }
      };
    case "turn_end":
      return {
        operationId: event.runId,
        event: {
          type: "turn_end",
          operationId: event.runId,
          turnId: event.turnId
        }
      };
    case "message_start": {
      const message = projectAgentMessage(
        event.message,
        event.runId === undefined ? "pending" : streamingMessageId(event.runId)
      );
      if (!message) return undefined;
      return {
        ...(event.runId === undefined ? {} : { operationId: event.runId }),
        event: {
          type: "message_start",
          ...(event.runId === undefined ? {} : { operationId: event.runId }),
          message
        }
      };
    }
    case "message_update": {
      if (!event.frame) return undefined;
      const delta = projectFrame(event.frame, streamingMessageId(event.runId));
      if (!delta) return undefined;
      return {
        operationId: event.runId,
        event: { type: "message_delta", operationId: event.runId, delta }
      };
    }
    case "message_end":
      return {
        ...(event.runId === undefined ? {} : { operationId: event.runId }),
        event: {
          type: "message_end",
          ...(event.runId === undefined ? {} : { operationId: event.runId }),
          ...(event.entryId === undefined ? {} : { entryId: event.entryId })
        }
      };
    case "tool_start":
      return {
        operationId: event.runId,
        event: {
          type: "tool_start",
          operationId: event.runId,
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          // SAFETY: pi validated these arguments against the tool schema.
          arguments: event.args as PiJson
        }
      };
    case "tool_update":
      return {
        operationId: event.runId,
        event: {
          type: "tool_update",
          operationId: event.runId,
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partial: projectToolResult(event.partialResult)
        }
      };
    case "tool_end":
      return {
        operationId: event.runId,
        event: {
          type: "tool_end",
          operationId: event.runId,
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: projectToolResult(event.result),
          error: event.isError
        }
      };
    case "entry_added": {
      switch (event.entry.type) {
        case "message": {
          const message = projectEntry(event.entry);
          return message ? { event: { type: "message", message } } : undefined;
        }
        case "compaction":
          return { event: { type: "transcript_reset", reason: "compaction" } };
        case "branch_summary":
          return { event: { type: "transcript_reset", reason: "navigation" } };
        default:
          return undefined;
      }
    }
    case "queue_update":
      return {
        event: { type: "queue_update", queue: projectQueue(event.queues) }
      };
    case "config_update":
      if (
        event.property !== "model" &&
        event.property !== "thinkingLevel" &&
        event.property !== "activeTools"
      ) {
        return undefined;
      }
      return {
        event: {
          type: "config_update",
          property: event.property,
          // SAFETY: lane configuration values are JSON pi persisted.
          value: event.value as PiJson
        }
      };
    case "compaction_start":
      return {
        operationId: event.runId,
        event: {
          type: "compaction_start",
          operationId: event.runId,
          reason: event.reason
        }
      };
    case "compaction_end":
      return {
        operationId: event.runId,
        event: {
          type: "compaction_end",
          operationId: event.runId,
          reason: event.reason,
          status: event.status
        }
      };
    case "navigation_start":
      return {
        operationId: event.runId,
        event: {
          type: "navigation_start",
          operationId: event.runId,
          targetId: event.targetId
        }
      };
    case "navigation_end":
      return {
        operationId: event.runId,
        event: {
          type: "navigation_end",
          operationId: event.runId,
          status: event.status
        }
      };
    case "fault":
      return {
        event: { type: "fault", code: event.code, message: event.message }
      };
    default:
      return undefined;
  }
}

const FLUSH_INTERVAL_MS = 100;
const MAX_EVENTS_PER_CHUNK = 64;
const MAX_CHUNK_BYTES = 256 * 1024;

/** Events that end a client-visible phase and are flushed without delay. */
const FLUSH_IMMEDIATELY = new Set<PiEvent["type"]>([
  "operation_start",
  "operation_end",
  "operation_abort",
  "operation_wait",
  "turn_end",
  "tool_end",
  "message",
  "message_end",
  "transcript_reset",
  "compaction_end",
  "navigation_end",
  "fault"
]);

/** One durable chunk appended to an operation stream. */
export type OperationChunk = {
  readonly seq: number;
  readonly events: readonly PiEvent[];
};

/**
 * Packs one operation's events into its durable stream. Token deltas arrive
 * far faster than a row write should, so events buffer synchronously and
 * flush as one chunk on a short timer, on size, or when a phase ends —
 * durability per chunk is unchanged while row writes drop by an order of
 * magnitude versus per-event appends.
 */
export class OperationStreamWriter {
  readonly streamId: string;
  readonly operationId: string;
  readonly lane: string;
  readonly #writer: StreamWriter | undefined;
  readonly #onChunk: ((chunk: OperationChunk) => void) | undefined;
  #buffer: PiEvent[] = [];
  #bufferedBytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: {
    readonly streamId: string;
    readonly operationId: string;
    readonly lane: string;
    /** Undefined when the stream already settled: events are dropped. */
    readonly writer: StreamWriter | undefined;
    readonly onChunk?: (chunk: OperationChunk) => void;
  }) {
    this.streamId = options.streamId;
    this.operationId = options.operationId;
    this.lane = options.lane;
    this.#writer = options.writer;
    this.#onChunk = options.onChunk;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(event: PiEvent): void {
    if (this.#closed || !this.#writer) return;
    const bytes = JSON.stringify(event).length;
    if (
      this.#buffer.length > 0 &&
      (this.#buffer.length >= MAX_EVENTS_PER_CHUNK ||
        this.#bufferedBytes + bytes > MAX_CHUNK_BYTES)
    ) {
      this.flush();
    }
    this.#buffer.push(event);
    this.#bufferedBytes += bytes;
    if (FLUSH_IMMEDIATELY.has(event.type)) {
      this.flush();
      return;
    }
    this.#timer ??= setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /** Append the buffered events as one chunk. */
  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#buffer.length === 0 || !this.#writer) return;
    const events = this.#buffer;
    this.#buffer = [];
    this.#bufferedBytes = 0;
    try {
      // SAFETY: PiEvent values are built from JSON-compatible pi payloads and
      // our own literals; Streams re-validates the serialized size.
      const seq = this.#writer.append(
        events as unknown as Parameters<StreamWriter["append"]>[0]
      );
      this.#onChunk?.({ seq, events });
    } catch (error) {
      // A settled or deleted stream cannot take more chunks; the operation's
      // durable state lives in pi regardless.
      console.warn(
        `PiHarness dropped ${events.length} event(s) for stream ${this.streamId}`,
        error
      );
    }
  }

  /** Flush and settle the stream. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.flush();
    this.#closed = true;
    try {
      this.#writer?.close();
    } catch (error) {
      console.warn(`PiHarness failed to close stream ${this.streamId}`, error);
    }
  }
}
