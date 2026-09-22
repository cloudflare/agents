/** Project TanStack model chunks onto the AG-UI 1.0 client protocol. */
import {
  EventType,
  PROTOCOL_VERSION,
  type AGUIEvent,
  type RunFinishedOutcome,
  type TokenUsage
} from "@ag-ui/core";
import type { StreamChunk } from "@tanstack/ai";
import type { StreamJson, StreamWriter } from "agents/streams";
import type { HarnessRole, JSON, PendingApproval } from "./protocol";

export { PROTOCOL_VERSION };

/** Bytes of streamed text coalesced before entering an event batch. */
export const TEXT_FLUSH_BYTES = 512;
const MAX_EVENTS_PER_BATCH = 32;
const MAX_BATCH_BYTES = 16 * 1024;
const FLUSH_INTERVAL_MS = 25;
const FLUSH_EVENTS = new Set<AGUIEvent["type"]>([
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.STEP_STARTED,
  EventType.STEP_FINISHED,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_END,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_END,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_RESULT,
  EventType.CUSTOM
]);

/** Buffer high-frequency AG-UI events into one durable Streams append. */
export class BufferedEventWriter implements StreamWriter {
  readonly streamId: string;
  readonly #writer: StreamWriter;
  #events: AGUIEvent[] = [];
  #bytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(writer: StreamWriter) {
    this.#writer = writer;
    this.streamId = writer.streamId;
  }

  get cursor(): number {
    return this.#writer.cursor;
  }

  append(chunk: StreamJson): number {
    const event = chunk as AGUIEvent;
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (
      this.#events.length > 0 &&
      (this.#events.length >= MAX_EVENTS_PER_BATCH ||
        this.#bytes + bytes > MAX_BATCH_BYTES)
    ) {
      this.flush();
    }
    this.#events.push(event);
    this.#bytes += bytes;
    if (FLUSH_EVENTS.has(event.type)) this.flush();
    else this.#timer ??= setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    return this.#writer.cursor;
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#events.length === 0) return;
    const events = this.#events;
    this.#events = [];
    this.#bytes = 0;
    this.#writer.append(events as unknown as StreamJson);
  }

  close(options?: Parameters<StreamWriter["close"]>[0]): void {
    this.flush();
    this.#writer.close(options);
  }

  error(reason?: string, options?: Parameters<StreamWriter["error"]>[1]): void {
    this.flush();
    this.#writer.error(reason, options);
  }
}

export type ChunkProjectionContext = {
  readonly turnId: string;
  readonly round: number;
  readonly attempt: number;
};

export function assistantMessageId(
  turnId: string,
  round: number,
  attempt: number
): string {
  return `assistant:${turnId}:${round}:attempt:${attempt}`;
}

export function reasoningMessageId(
  turnId: string,
  round: number,
  attempt: number
): string {
  return `reasoning:${turnId}:${round}:${attempt}`;
}

export function toolCallKey(round: number, providerCallId: string): string {
  return `${round}:${providerCallId}`;
}

/** Translate one TanStack event to its schema-valid AG-UI 1.0 equivalent. */
export function projectChunk(
  chunk: StreamChunk,
  context: ChunkProjectionContext
): AGUIEvent | null {
  const messageId = assistantMessageId(
    context.turnId,
    context.round,
    context.attempt
  );
  const reasoningId = reasoningMessageId(
    context.turnId,
    context.round,
    context.attempt
  );
  switch (chunk.type) {
    case "TEXT_MESSAGE_START":
      return {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant"
      };
    case "TEXT_MESSAGE_CONTENT":
      return {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: chunk.delta ?? ""
      };
    case "TEXT_MESSAGE_END":
      return { type: EventType.TEXT_MESSAGE_END, messageId };
    case "REASONING_MESSAGE_START":
      return {
        type: EventType.REASONING_MESSAGE_START,
        messageId: reasoningId,
        role: "reasoning"
      };
    case "REASONING_MESSAGE_CONTENT":
      return {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: reasoningId,
        delta: chunk.delta ?? ""
      };
    case "REASONING_MESSAGE_END":
      return { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId };
    case "TOOL_CALL_START":
      return {
        type: EventType.TOOL_CALL_START,
        toolCallId: toolCallKey(context.round, chunk.toolCallId),
        toolCallName: chunk.toolCallName ?? chunk.toolName ?? "unknown",
        parentMessageId: messageId,
        metadata: {
          cloudflare: { providerCallId: chunk.toolCallId, round: context.round }
        }
      };
    case "TOOL_CALL_ARGS":
      return {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: toolCallKey(context.round, chunk.toolCallId),
        delta: chunk.delta ?? ""
      };
    case "TOOL_CALL_END":
      return {
        type: EventType.TOOL_CALL_END,
        toolCallId: toolCallKey(context.round, chunk.toolCallId)
      };
    default:
      return null;
  }
}

export function toolCallArgsEvent(
  toolCallId: string,
  delta: string
): AGUIEvent {
  return { type: EventType.TOOL_CALL_ARGS, toolCallId, delta };
}

export function textMessageEndEvent(messageId: string): AGUIEvent {
  return { type: EventType.TEXT_MESSAGE_END, messageId };
}

export function reasoningMessageEndEvent(messageId: string): AGUIEvent {
  return { type: EventType.REASONING_MESSAGE_END, messageId };
}

export function runStartedEvent(
  threadId: string,
  runId: string,
  role: HarnessRole
): AGUIEvent {
  return {
    type: EventType.RUN_STARTED,
    threadId,
    runId,
    protocolVersion: PROTOCOL_VERSION,
    metadata: { cloudflare: { role } }
  };
}

export function runFinishedEvent(
  threadId: string,
  runId: string,
  result: JSON,
  outcome: RunFinishedOutcome = { type: "success" },
  usage?: TokenUsage[]
): AGUIEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    result,
    outcome,
    ...(usage ? { usage } : {})
  };
}

export function runErrorEvent(message: string, code?: string): AGUIEvent {
  return {
    type: EventType.RUN_ERROR,
    message,
    ...(code ? { code } : {})
  };
}

export function stepStartedEvent(
  stepName: string,
  metadata?: Record<string, JSON>
): AGUIEvent {
  return {
    type: EventType.STEP_STARTED,
    stepName,
    ...(metadata ? { metadata } : {})
  };
}

export function stepFinishedEvent(
  stepName: string,
  metadata?: Record<string, JSON>
): AGUIEvent {
  return {
    type: EventType.STEP_FINISHED,
    stepName,
    ...(metadata ? { metadata } : {})
  };
}

export function toolResultEvent(input: {
  readonly messageId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly ok: boolean;
}): AGUIEvent {
  return {
    type: EventType.TOOL_CALL_RESULT,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    content: input.content,
    metadata: {
      cloudflare: { toolName: input.toolName, ok: input.ok }
    }
  };
}

export function customEvent(name: string, value: JSON): AGUIEvent {
  return { type: EventType.CUSTOM, name, value };
}

export function approvalRequestedEvent(approval: PendingApproval): AGUIEvent {
  return customEvent("cloudflare.authorization.requested", {
    approvalId: approval.approvalId,
    turnId: approval.turnId,
    toolName: approval.toolName,
    input: approval.input,
    requestedAt: approval.requestedAt
  });
}

/** Normalize token counts across TanStack's supported usage shapes. */
export function usageOf(
  chunk: StreamChunk
): { inputTokens?: number; outputTokens?: number } | null {
  if (chunk.type !== "RUN_FINISHED" && chunk.type !== "RUN_ERROR") return null;
  if (!chunk.usage) return null;
  const records = Array.isArray(chunk.usage) ? chunk.usage : [chunk.usage];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const record of records) {
    inputTokens += numeric(record, "inputTokens", "promptTokens");
    outputTokens += numeric(record, "outputTokens", "completionTokens");
  }
  return { inputTokens, outputTokens };
}

function numeric(record: unknown, ...keys: string[]): number {
  if (typeof record !== "object" || record === null) return 0;
  for (const key of keys) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

/** Coalesce text without losing the AG-UI message identity. */
export class TextCoalescer {
  #buffer = "";
  #bytes = 0;

  constructor(
    private readonly emit: (event: AGUIEvent) => void,
    private readonly messageId: string,
    private readonly flushBytes = TEXT_FLUSH_BYTES,
    private readonly type: "text" | "reasoning" = "text"
  ) {}

  push(delta: string): void {
    this.#buffer += delta;
    this.#bytes += new TextEncoder().encode(delta).length;
    if (this.#bytes >= this.flushBytes) this.flush();
  }

  flush(): void {
    if (this.#buffer.length === 0) return;
    this.emit(
      this.type === "text"
        ? {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: this.messageId,
            delta: this.#buffer
          }
        : {
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: this.messageId,
            delta: this.#buffer
          }
    );
    this.#buffer = "";
    this.#bytes = 0;
  }
}
