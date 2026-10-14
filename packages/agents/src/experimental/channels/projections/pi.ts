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
import type {
  EntryRecord,
  MessageChange,
  UserInput
} from "@earendil-works/pi-durable";
import type { InputPart } from "../harness";
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
 * Project input parts into pi's user input. Text stays text, collapsed to a
 * string when it is the only part; a base64 data-URL image becomes an image.
 * pi takes no other files, so they are dropped.
 */
export function toUserInput(parts: readonly InputPart[]): UserInput {
  const out = parts.flatMap((part): Exclude<UserInput, string>[number][] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    const data = /^data:([^;,]+);base64,(.*)$/.exec(part.url);
    return data && part.mediaType.startsWith("image/")
      ? [{ type: "image", mimeType: data[1], data: data[2] }]
      : [];
  });
  return out.length === 1 && out[0].type === "text" ? out[0].text : out;
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
 *
 * pi builds its events from commits and coalesces live updates, so a
 * block's text can arrive in a delta, a whole block, a whole message, or
 * only in the saved entry. This counts the characters emitted per block and
 * emits whatever is missing from each fuller copy, relying on pi only ever
 * appending to a block's text.
 */
export class PiChunkProjection {
  #open = new Map<number, { kind: "text" | "reasoning"; id: string }>();
  /** Characters emitted per content index of the current message. */
  #emitted = new Map<number, number>();
  #message = 0;
  readonly #calls = new Set<string>();

  /**
   * A new assistant message starts, from a `message_start` event or a
   * snapshot's in-flight message. Its text so far is emitted, with text and
   * reasoning parts left open so the deltas that follow continue them. Tool
   * calls wait for their block or the message end.
   */
  startMessage(partial?: AssistantMessage): ResponseChunk[] {
    this.#message += 1;
    this.#open.clear();
    this.#emitted.clear();
    const out: ResponseChunk[] = [];
    partial?.content.forEach((block, index) => {
      if (block.type === "toolCall") return;
      const kind = block.type === "thinking" ? "reasoning" : "text";
      const part = this.#start(index, kind, out);
      this.#delta(index, part.id, kind, blockText(block), out);
    });
    return out;
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
          this.#delta(
            change.contentIndex,
            part.id,
            kind,
            blockText(change.block),
            out
          );
          break;
        }
        case "text_delta":
        case "thinking_delta": {
          const kind = change.type === "text_delta" ? "text" : "reasoning";
          const part = this.#start(change.contentIndex, kind, out);
          this.#delta(change.contentIndex, part.id, kind, change.delta, out);
          break;
        }
        case "block":
          if (change.block.type === "toolCall") {
            const { id, name, arguments: input } = change.block;
            out.push(...this.#toolCall(id, name, input));
          } else {
            this.#rest(change.contentIndex, change.block, out);
            this.#close(change.contentIndex, out);
          }
          break;
        case "message":
          change.message.content.forEach((block, index) =>
            this.#rest(index, block, out)
          );
          break;
        default:
          // Tool call deltas: the call is shown once its block completes.
          break;
      }
    }
    return out;
  }

  /**
   * The chunks for a `message_end` event's saved message: text no update
   * carried, then the open parts close, then tool calls pi completed only at
   * the message end.
   */
  endMessage(message: Message | undefined): ResponseChunk[] {
    const out: ResponseChunk[] = [];
    if (message?.role === "assistant") {
      message.content.forEach((block, index) => this.#rest(index, block, out));
    }
    out.push(...this.end());
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

  /** Emit whatever of the block's text has not been emitted yet. */
  #rest(
    index: number,
    block: AssistantMessage["content"][number],
    out: ResponseChunk[]
  ): void {
    if (block.type !== "text" && block.type !== "thinking") return;
    const text = blockText(block);
    const done = this.#emitted.get(index) ?? 0;
    if (text.length <= done) return;
    const kind = block.type === "thinking" ? "reasoning" : "text";
    const part = this.#start(index, kind, out);
    this.#delta(index, part.id, kind, text.slice(done), out);
  }

  #delta(
    index: number,
    id: string,
    kind: "text" | "reasoning",
    delta: string,
    out: ResponseChunk[]
  ): void {
    if (!delta) return;
    this.#emitted.set(index, (this.#emitted.get(index) ?? 0) + delta.length);
    out.push({ type: `${kind}-delta`, id, delta });
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
