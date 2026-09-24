import type { StreamWriter } from "../streams";
import type { OCEvent, OCJson } from "./types";

type RawEvent = {
  readonly type: string;
  readonly created?: number;
  readonly data?: Record<string, unknown>;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || !("message" in value)) {
    return undefined;
  }
  return str(value.message);
}

export function sessionIdOf(event: RawEvent): string | undefined {
  return str(event.data?.sessionID);
}

export function projectEvent(event: RawEvent): OCEvent | undefined {
  const data = event.data ?? {};
  switch (event.type) {
    case "session.text.started":
      return undefined;
    case "session.text.delta":
      return {
        type: "text_delta",
        messageId: str(data.assistantMessageID) ?? str(data.messageID) ?? "",
        partId: identifier(data.ordinal) ?? str(data.partID) ?? "",
        delta: str(data.delta) ?? ""
      };
    case "session.reasoning.delta":
      return {
        type: "reasoning_delta",
        messageId: str(data.assistantMessageID) ?? str(data.messageID) ?? "",
        partId: identifier(data.ordinal) ?? str(data.partID) ?? "",
        delta: str(data.delta) ?? ""
      };
    case "session.tool.called":
      return {
        type: "tool_start",
        toolCallId: str(data.toolID) ?? str(data.id) ?? "",
        name: str(data.tool) ?? str(data.name) ?? "",
        input: (data.input ?? null) as OCJson
      };
    case "session.tool.success":
      return {
        type: "tool_end",
        toolCallId: str(data.toolID) ?? str(data.id) ?? "",
        name: str(data.tool) ?? str(data.name) ?? "",
        error: false,
        output: str(data.output)
      };
    case "session.tool.failed":
      return {
        type: "tool_end",
        toolCallId: str(data.toolID) ?? str(data.id) ?? "",
        name: str(data.tool) ?? str(data.name) ?? "",
        error: true,
        output: errorMessage(data.error)
      };
    case "permission.asked":
      return {
        type: "permission_asked",
        permission: {
          id: str(data.id) ?? "",
          sessionId: str(data.sessionID) ?? "",
          action: str(data.action) ?? "",
          resources: Array.isArray(data.resources)
            ? (data.resources as string[])
            : [],
          askedAt: event.created ?? Date.now()
        }
      };
    case "permission.replied":
      return {
        type: "permission_replied",
        permissionId: str(data.requestID) ?? str(data.id) ?? ""
      };
    case "session.step.ended":
      return {
        type: "message_end",
        messageId: str(data.assistantMessageID) ?? str(data.messageID) ?? ""
      };
    case "session.compaction.ended":
      return { type: "transcript_reset", reason: "compaction" };
    case "session.execution.failed":
      return {
        type: "fault",
        code: "execution_failed",
        message:
          str((data.error as Record<string, unknown> | undefined)?.message) ??
          "The OpenCode execution failed"
      };
    default:
      return undefined;
  }
}

const FLUSH_INTERVAL_MS = 100;
const MAX_EVENTS_PER_CHUNK = 64;
const MAX_CHUNK_BYTES = 256 * 1024;

const FLUSH_IMMEDIATELY = new Set<OCEvent["type"]>([
  "operation_start",
  "operation_end",
  "operation_wait",
  "tool_end",
  "message_end",
  "permission_asked",
  "permission_replied",
  "transcript_reset",
  "fault"
]);

export type OperationChunk = {
  readonly seq: number;
  readonly events: readonly OCEvent[];
};

export class OperationStreamWriter {
  readonly streamId: string;
  readonly operationId: string;
  readonly #writer: StreamWriter | undefined;
  readonly #onChunk: ((chunk: OperationChunk) => void) | undefined;
  #buffer: OCEvent[] = [];
  #bufferedBytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: {
    readonly streamId: string;
    readonly operationId: string;

    readonly writer: StreamWriter | undefined;
    readonly onChunk?: (chunk: OperationChunk) => void;
  }) {
    this.streamId = options.streamId;
    this.operationId = options.operationId;
    this.#writer = options.writer;
    this.#onChunk = options.onChunk;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get writable(): boolean {
    return !this.#closed && this.#writer !== undefined;
  }

  push(event: OCEvent): void {
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
    const seq = this.#writer.append(
      events as unknown as Parameters<StreamWriter["append"]>[0]
    );
    this.#onChunk?.({ seq, events });
  }

  close(): void {
    if (this.#closed) return;
    this.flush();
    this.#writer?.close();
    this.#closed = true;
  }
}
