import type { UIMessageChunk } from "ai";
import type { ChannelChunk } from "../channel";
import { isRecord } from "../internal";

export type WebChatRequestBody = {
  messages: unknown[];
  [key: string]: unknown;
};

export type NormalizedWebChatMessage = {
  id: string;
  text: string;
};

/** Read the latest user message from an AI SDK useChat request body. */
export function normalizeWebChatRequest(
  body: unknown
): { body: WebChatRequestBody; message: NormalizedWebChatMessage } | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;

  let candidate: unknown;
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (isRecord(message) && message.role === "user") {
      candidate = message;
      break;
    }
  }
  if (!isRecord(candidate)) return null;

  const id = typeof candidate.id === "string" ? candidate.id : undefined;
  if (!id) return null;

  const text = Array.isArray(candidate.parts)
    ? candidate.parts
        .filter(
          (part): part is { type: "text"; text: string } =>
            isRecord(part) &&
            part.type === "text" &&
            typeof part.text === "string"
        )
        .map((part) => part.text)
        .join("")
    : typeof candidate.content === "string"
      ? candidate.content
      : "";

  return {
    body: body as WebChatRequestBody,
    message: { id, text }
  };
}

/** Stateful projection from neutral Channel chunks to AI SDK UI chunks. */
export class WebChatChunkEncoder {
  readonly #requestId: string;
  #active: { type: "text" | "reasoning"; id: string } | undefined;
  #part = 0;
  #source = 0;

  constructor(requestId: string) {
    this.#requestId = requestId;
  }

  push(chunk: ChannelChunk): UIMessageChunk[] {
    switch (chunk.type) {
      case "text":
      case "reasoning": {
        const output = this.#switchTo(chunk.type);
        output.push({
          type: `${chunk.type}-delta`,
          id: this.#active!.id,
          delta: chunk.text
        } as UIMessageChunk);
        return output;
      }
      case "source":
        return [
          ...this.finishPart(),
          {
            type: "source-url",
            sourceId: `${this.#requestId}:source:${++this.#source}`,
            url: chunk.url,
            ...(chunk.title !== undefined && { title: chunk.title })
          }
        ];
      case "tool":
        // Tool progress has no lossless AI SDK UI chunk equivalent. Text is
        // required to remain complete without it by the Channel contract.
        return [];
    }
  }

  finishPart(): UIMessageChunk[] {
    if (!this.#active) return [];
    const active = this.#active;
    this.#active = undefined;
    return [{ type: `${active.type}-end`, id: active.id } as UIMessageChunk];
  }

  #switchTo(type: "text" | "reasoning"): UIMessageChunk[] {
    if (this.#active?.type === type) return [];
    const output = this.finishPart();
    const id = `${this.#requestId}:${type}:${++this.#part}`;
    this.#active = { type, id };
    output.push({ type: `${type}-start`, id } as UIMessageChunk);
    return output;
  }
}
