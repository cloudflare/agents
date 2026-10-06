/**
 * The pi projection: pi-durable transcript entries and live agent events to
 * Channels transcript messages and response chunks.
 *
 * @experimental The API may change between releases.
 */
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent
} from "@earendil-works/pi-ai";
import type { EntryRecord, MessageChange } from "@earendil-works/pi-durable";
import type {
  Json,
  MessagePart,
  ResponseChunk,
  ToolPart,
  TranscriptMessage
} from "../protocol";

// SAFETY: pi's tool arguments and details are JSON by pi-ai's own types.
const json = (value: unknown): Json => (value ?? null) as Json;

/**
 * Project pi transcript entries into transcript messages. Each message has
 * its entry's id. A tool result folds into the assistant message holding its
 * call, and a reset becomes a system message. System-prompt entries and other
 * bookkeeping have no projection.
 */
export function toTranscriptMessages(
  entries: readonly EntryRecord[]
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const calls = new Map<string, ToolPart>();
  for (const entry of entries) {
    const id = String(entry.id);
    if (entry.kind === "pi.reset") {
      out.push({
        id,
        role: "system",
        parts: [{ type: "text", text: "Context reset" }]
      });
      continue;
    }
    const message = entry.model?.[0];
    if (entry.kind === "pi.system" || message === undefined) continue;
    switch (message.role) {
      case "system":
        // pi records prompt changes as system entries; they are not shown.
        break;
      case "user":
        out.push({
          id,
          role: "user",
          parts:
            typeof message.content === "string"
              ? [{ type: "text", text: message.content }]
              : message.content.map(contentPart)
        });
        break;
      case "assistant": {
        const parts = message.content.map((block): MessagePart => {
          switch (block.type) {
            case "text":
              return { type: "text", text: block.text };
            case "thinking":
              return { type: "reasoning", text: block.thinking };
            case "toolCall": {
              const call: ToolPart = {
                type: "tool",
                toolCallId: block.id,
                toolName: block.name,
                state: "input-available",
                input: json(block.arguments)
              };
              calls.set(block.id, call);
              return call;
            }
          }
        });
        if (message.errorMessage !== undefined) {
          parts.push({ type: "text", text: `Error: ${message.errorMessage}` });
        }
        out.push({ id, role: "assistant", parts });
        break;
      }
      case "toolResult": {
        const call = calls.get(message.toolCallId);
        if (!call) break;
        if (message.isError) {
          call.state = "output-error";
          call.errorText = toolText(message.content);
        } else {
          call.state = "output-available";
          call.output = toolOutput(message.content, message.details);
        }
        break;
      }
    }
  }
  return out;
}

/**
 * Project a tool's saved result into the response chunk that settles its
 * call. Returns undefined when the message is not a tool result.
 */
export function toToolOutputChunk(
  toolCallId: string,
  message: Message | undefined
): ResponseChunk | undefined {
  if (message?.role !== "toolResult") return undefined;
  return message.isError
    ? {
        type: "tool-output-error",
        toolCallId,
        errorText: toolText(message.content)
      }
    : {
        type: "tool-output-available",
        toolCallId,
        output: toolOutput(message.content, message.details)
      };
}

/**
 * Projects one pi run's live assistant messages into response chunks. pi
 * addresses a message's blocks by index, so this keeps the open parts and
 * gives them ids unique across the run's messages. Use one per run.
 */
export class PiChunkProjection {
  #open = new Map<number, { kind: "text" | "reasoning"; id: string }>();
  #message = 0;
  readonly #calls = new Set<string>();

  /** A new assistant message starts. Its block indexes start again. */
  startMessage(): void {
    this.#message += 1;
    this.#open.clear();
  }

  /** The chunks for a `message_update` event's changes. */
  changes(changes: readonly MessageChange[]): ResponseChunk[] {
    const out: ResponseChunk[] = [];
    for (const change of changes) {
      switch (change.type) {
        case "text_start":
        case "thinking_start": {
          const kind = change.block.type === "thinking" ? "reasoning" : "text";
          const part = this.#start(change.contentIndex, kind, out);
          const text = blockText(change.block);
          if (text)
            out.push({ type: `${kind}-delta`, id: part.id, delta: text });
          break;
        }
        case "text_delta":
        case "thinking_delta": {
          const kind = change.type === "text_delta" ? "text" : "reasoning";
          const part = this.#start(change.contentIndex, kind, out);
          out.push({ type: `${kind}-delta`, id: part.id, delta: change.delta });
          break;
        }
        case "block":
          if (change.block.type === "toolCall") {
            const { id, name, arguments: input } = change.block;
            out.push(...this.#toolCall(id, name, input));
          } else this.#close(change.contentIndex, out);
          break;
        default:
          // Tool call deltas: the call is shown once its block completes.
          break;
      }
    }
    return out;
  }

  /**
   * Join a message already in progress. Text and reasoning stay open under
   * the ids later deltas use. Tool calls wait for their block or the message
   * end, as when streaming.
   */
  resume(message: AssistantMessage): ResponseChunk[] {
    const out: ResponseChunk[] = [];
    message.content.forEach((block, index) => {
      if (block.type === "toolCall") return;
      const kind = block.type === "thinking" ? "reasoning" : "text";
      const part = this.#start(index, kind, out);
      const text = blockText(block);
      if (text) out.push({ type: `${kind}-delta`, id: part.id, delta: text });
    });
    return out;
  }

  /**
   * The chunks for a `message_end` event's saved message: open parts close,
   * and tool calls pi completed only at the message end are shown.
   */
  endMessage(message: Message | undefined): ResponseChunk[] {
    const out = this.end();
    if (message?.role !== "assistant") return out;
    for (const block of message.content) {
      if (block.type === "toolCall") {
        out.push(...this.#toolCall(block.id, block.name, block.arguments));
      }
    }
    return out;
  }

  /** Close every open part, as the run ends. */
  end(): ResponseChunk[] {
    const out: ResponseChunk[] = [];
    for (const index of [...this.#open.keys()]) this.#close(index, out);
    return out;
  }

  /** A tool call, once. pi may complete it in a block or only at message end. */
  #toolCall(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): ResponseChunk[] {
    if (this.#calls.has(toolCallId)) return [];
    this.#calls.add(toolCallId);
    return [
      { type: "tool-input-start", toolCallId, toolName },
      { type: "tool-input-available", toolCallId, toolName, input: json(input) }
    ];
  }

  #start(index: number, kind: "text" | "reasoning", out: ResponseChunk[]) {
    const open = this.#open.get(index);
    if (open) return open;
    const part = { kind, id: `${this.#message}:${index}` };
    this.#open.set(index, part);
    out.push({ type: `${kind}-start`, id: part.id });
    return part;
  }

  #close(index: number, out: ResponseChunk[]): void {
    const part = this.#open.get(index);
    if (!part) return;
    this.#open.delete(index);
    out.push({ type: `${part.kind}-end`, id: part.id });
  }
}

function contentPart(part: TextContent | ImageContent): MessagePart {
  return part.type === "text"
    ? { type: "text", text: part.text }
    : {
        type: "file",
        mediaType: part.mimeType,
        url: `data:${part.mimeType};base64,${part.data}`
      };
}

function blockText(block: AssistantMessage["content"][number]): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.thinking;
  return "";
}

function toolText(content: readonly { type: string; text?: string }[]): string {
  return content.map((part) => part.text ?? "").join("");
}

function toolOutput(
  content: readonly { type: string; text?: string }[],
  details: unknown
): Json {
  return json(details ?? toolText(content));
}
