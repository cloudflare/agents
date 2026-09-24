import type {
  HarnessEvent,
  HarnessEventType
} from "@earendil-works/pi-agent-core";
import type { StreamWriter } from "../streams";
import {
  projectAgentMessage,
  projectEntry,
  projectFrame,
  projectQueue,
  projectToolResult
} from "./messages";
import type { PiEvent, PiJson } from "./types";

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

export type ProjectedEvent = {
  readonly event: PiEvent;
  readonly operationId?: string;
};

function streamingMessageId(runId: string): string {
  return `pending:${runId}`;
}

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
        operationId: event.runId,
        event: {
          type: "message_start",
          operationId: event.runId,
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
        operationId: event.runId,
        event: {
          type: "message_end",
          operationId: event.runId,
          entryId: event.entryId
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

export type OperationChunk = {
  readonly seq: number;
  readonly events: readonly PiEvent[];
};

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
      const seq = this.#writer.append(
        events as unknown as Parameters<StreamWriter["append"]>[0]
      );
      this.#onChunk?.({ seq, events });
    } catch (error) {
      console.warn(
        `PiHarness dropped ${events.length} event(s) for stream ${this.streamId}`,
        error
      );
    }
  }

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
