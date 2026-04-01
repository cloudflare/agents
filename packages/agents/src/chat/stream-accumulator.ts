/**
 * StreamAccumulator — unified chunk-to-message builder.
 *
 * Used by @cloudflare/ai-chat (server + client) and @cloudflare/think
 * to incrementally build a UIMessage from stream chunks. Wraps
 * applyChunkToParts and handles the metadata chunk types (start, finish,
 * message-metadata, error) that applyChunkToParts does not cover.
 *
 * The accumulator signals domain-specific concerns (early persistence,
 * cross-message tool updates) via ChunkAction returns — callers handle
 * these according to their context.
 */

import type { UIMessage } from "ai";
import { applyChunkToParts, type StreamChunkData } from "./message-builder";

function asMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export interface StreamAccumulatorOptions {
  messageId: string;
  continuation?: boolean;
  existingParts?: UIMessage["parts"];
  existingMetadata?: Record<string, unknown>;
}

export type ChunkAction =
  | {
      type: "start";
      messageId?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "finish";
      finishReason?: string;
      metadata?: Record<string, unknown>;
    }
  | { type: "message-metadata"; metadata: Record<string, unknown> }
  | { type: "tool-approval-request"; toolCallId: string }
  | {
      type: "cross-message-tool-update";
      updateType: "output-available" | "output-error";
      toolCallId: string;
      output?: unknown;
      errorText?: string;
      preliminary?: boolean;
    }
  | { type: "error"; error: string };

export interface ChunkResult {
  handled: boolean;
  action?: ChunkAction;
}

export class StreamAccumulator {
  messageId: string;
  readonly parts: UIMessage["parts"];
  metadata?: Record<string, unknown>;
  private _isContinuation: boolean;

  constructor(options: StreamAccumulatorOptions) {
    this.messageId = options.messageId;
    this._isContinuation = options.continuation ?? false;
    this.parts = options.existingParts ? [...options.existingParts] : [];
    this.metadata = options.existingMetadata
      ? { ...options.existingMetadata }
      : undefined;
  }

  applyChunk(chunk: StreamChunkData): ChunkResult {
    const handled = applyChunkToParts(this.parts, chunk);

    // Detect tool-approval-request for early persistence signaling
    if (chunk.type === "tool-approval-request" && chunk.toolCallId) {
      return {
        handled,
        action: { type: "tool-approval-request", toolCallId: chunk.toolCallId }
      };
    }

    // Detect cross-message tool output/error: applyChunkToParts returns true
    // for recognized types but silently does nothing when the toolCallId
    // doesn't exist in the current parts array.
    if (
      (chunk.type === "tool-output-available" ||
        chunk.type === "tool-output-error") &&
      chunk.toolCallId
    ) {
      const foundInParts = this.parts.some(
        (p) => "toolCallId" in p && p.toolCallId === chunk.toolCallId
      );
      if (!foundInParts) {
        return {
          handled,
          action: {
            type: "cross-message-tool-update",
            updateType:
              chunk.type === "tool-output-available"
                ? "output-available"
                : "output-error",
            toolCallId: chunk.toolCallId,
            output: chunk.output,
            errorText: chunk.errorText,
            preliminary: chunk.preliminary
          }
        };
      }
    }

    if (!handled) {
      switch (chunk.type) {
        case "start": {
          if (chunk.messageId != null && !this._isContinuation) {
            this.messageId = chunk.messageId;
          }
          const startMeta = asMetadata(chunk.messageMetadata);
          if (startMeta) {
            this.metadata = this.metadata
              ? { ...this.metadata, ...startMeta }
              : { ...startMeta };
          }
          return {
            handled: true,
            action: {
              type: "start",
              messageId: chunk.messageId,
              metadata: startMeta
            }
          };
        }
        case "finish": {
          const finishMeta = asMetadata(chunk.messageMetadata);
          if (finishMeta) {
            this.metadata = this.metadata
              ? { ...this.metadata, ...finishMeta }
              : { ...finishMeta };
          }
          const finishReason =
            "finishReason" in chunk
              ? (chunk.finishReason as string)
              : undefined;
          return {
            handled: true,
            action: {
              type: "finish",
              finishReason,
              metadata: finishMeta
            }
          };
        }
        case "message-metadata": {
          const msgMeta = asMetadata(chunk.messageMetadata);
          if (msgMeta) {
            this.metadata = this.metadata
              ? { ...this.metadata, ...msgMeta }
              : { ...msgMeta };
          }
          return {
            handled: true,
            action: {
              type: "message-metadata",
              metadata: msgMeta ?? {}
            }
          };
        }
        case "finish-step": {
          return { handled: true };
        }
        case "error": {
          return {
            handled: true,
            action: {
              type: "error",
              error: chunk.errorText ?? JSON.stringify(chunk)
            }
          };
        }
      }
    }

    return { handled };
  }

  /** Snapshot the current state as a UIMessage. */
  toMessage(): UIMessage {
    return {
      id: this.messageId,
      role: "assistant",
      parts: [...this.parts],
      ...(this.metadata != null && { metadata: this.metadata })
    } as UIMessage;
  }

  /**
   * Merge this accumulator's message into an existing message array.
   * Handles continuation (walk backward for last assistant), replacement
   * (update existing by messageId), or append (new message).
   */
  mergeInto(messages: UIMessage[]): UIMessage[] {
    let existingIdx = messages.findIndex((m) => m.id === this.messageId);

    if (existingIdx < 0 && this._isContinuation) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          existingIdx = i;
          break;
        }
      }
    }

    const messageId =
      existingIdx >= 0 ? messages[existingIdx].id : this.messageId;

    const partialMessage: UIMessage = {
      id: messageId,
      role: "assistant",
      parts: [...this.parts],
      ...(this.metadata != null && { metadata: this.metadata })
    } as UIMessage;

    if (existingIdx >= 0) {
      const updated = [...messages];
      updated[existingIdx] = partialMessage;
      return updated;
    }
    return [...messages, partialMessage];
  }
}
