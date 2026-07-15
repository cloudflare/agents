import { defaultIdSource } from "../../kernel/ids.js";
import type { ChatMessage, MessagePart, ToolPart } from "../messages/model.js";

/**
 * UI chunk vocabulary (rebuild-owned, mirrors concepts not wire bytes).
 * The turn loop converts model-stream events into this sequence; the
 * accumulator below folds a sequence of these back into a ChatMessage.
 */
export type UiChunk =
  | { type: "start"; messageId: string }
  // `id` is the streaming PART id ("t1", "t2", ...): consecutive deltas of a
  // kind share one; production always stamps it (turn loop); it is optional
  // only so hand-built test chunks stay terse.
  | { type: "text-delta"; id?: string; delta: string }
  | { type: "reasoning-delta"; id?: string; delta: string }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: unknown;
      /** "client" -> the browser must run it. */
      executor: "server" | "client";
    }
  | {
      type: "tool-approval-requested";
      toolCallId: string;
      toolName: string;
      input: unknown;
      descriptor?: unknown;
    }
  | { type: "tool-output-available"; toolCallId: string; output: unknown; isError?: boolean }
  | { type: "finish"; finishReason: string }
  | { type: "error"; errorText: string };

export interface StreamAccumulator {
  push(chunk: UiChunk): void;
  /** Stable id from the "start" chunk. Returns a partial snapshot at any point. */
  current(): ChatMessage;
  finished(): boolean;
}

type DeltaKind = "text" | "reasoning" | null;

/**
 * Folds a UiChunk sequence into an assistant ChatMessage: parts in arrival
 * order, consecutive deltas of the same kind coalesced into one part, tool
 * parts keyed by toolCallId transitioning
 * input-available|approval-requested -> output-available|output-error.
 */
export function createAccumulator(idFallback?: string): StreamAccumulator {
  let id: string | undefined = idFallback;
  const parts: MessagePart[] = [];
  const toolIndex = new Map<string, number>();
  let lastDeltaKind: DeltaKind = null;
  let done = false;
  let finishReason: string | undefined;
  let streamErrorText: string | undefined;

  function resolveId(): string {
    if (id === undefined) {
      id = defaultIdSource.newId("msg");
    }
    return id;
  }

  function appendDelta(kind: "text" | "reasoning", delta: string): void {
    const last = parts[parts.length - 1];
    if (lastDeltaKind === kind && last !== undefined && last.type === kind) {
      last.text += delta;
    } else {
      parts.push({ type: kind, text: delta });
    }
    lastDeltaKind = kind;
  }

  function upsertToolPart(toolCallId: string, toolName: string, state: ToolPart["state"], input: unknown): void {
    const existingAt = toolIndex.get(toolCallId);
    if (existingAt !== undefined) {
      const existing = parts[existingAt] as ToolPart;
      existing.state = state;
      existing.input = input;
    } else {
      const toolPart: ToolPart = {
        type: `tool-${toolName}`,
        toolCallId,
        state,
        input,
      };
      parts.push(toolPart);
      toolIndex.set(toolCallId, parts.length - 1);
    }
    lastDeltaKind = null;
  }

  function settleTool(toolCallId: string, output: unknown, isError: boolean): void {
    const at = toolIndex.get(toolCallId);
    if (at === undefined) {
      // No matching input/approval chunk was seen for this toolCallId: we
      // have no toolName to construct a part with, so there is nothing to
      // update. Silently ignored.
      return;
    }
    const toolPart = parts[at] as ToolPart;
    if (isError) {
      toolPart.state = "output-error";
      toolPart.errorText = typeof output === "string" ? output : JSON.stringify(output);
    } else {
      toolPart.state = "output-available";
      toolPart.output = output;
    }
    lastDeltaKind = null;
  }

  return {
    push(chunk: UiChunk): void {
      switch (chunk.type) {
        case "start":
          id = chunk.messageId;
          break;
        case "text-delta":
          appendDelta("text", chunk.delta);
          break;
        case "reasoning-delta":
          appendDelta("reasoning", chunk.delta);
          break;
        case "tool-input-available":
          upsertToolPart(chunk.toolCallId, chunk.toolName, "input-available", chunk.input);
          break;
        case "tool-approval-requested":
          upsertToolPart(chunk.toolCallId, chunk.toolName, "approval-requested", chunk.input);
          break;
        case "tool-output-available":
          settleTool(chunk.toolCallId, chunk.output, chunk.isError === true);
          break;
        case "finish":
          done = true;
          finishReason = chunk.finishReason;
          lastDeltaKind = null;
          break;
        case "error":
          done = true;
          streamErrorText = chunk.errorText;
          lastDeltaKind = null;
          break;
        default:
          // Unknown chunk types (e.g. from a newer/older protocol) are ignored.
          break;
      }
    },

    current(): ChatMessage {
      const message: ChatMessage = {
        id: resolveId(),
        role: "assistant",
        parts: structuredClone(parts),
      };
      if (finishReason !== undefined || streamErrorText !== undefined) {
        message.metadata = {
          ...(finishReason !== undefined ? { finishReason } : {}),
          ...(streamErrorText !== undefined ? { error: streamErrorText } : {}),
        };
      }
      return message;
    },

    finished(): boolean {
      return done;
    },
  };
}
