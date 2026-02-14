/**
 * Shared message builder for reconstructing UIMessage parts from stream chunks.
 *
 * Used by both the server (_streamSSEReply) and client (onAgentMessage in react.tsx)
 * to avoid duplicating the chunk-type switch/case logic. The server handles additional
 * chunk types (tool-input-start, tool-input-delta, etc.) on top of this shared base.
 *
 * Operates on a mutable parts array for performance (avoids allocating new arrays
 * on every chunk during streaming).
 */

import type { UIMessage } from "ai";

/** The parts array type from UIMessage */
export type MessageParts = UIMessage["parts"];

/** A single part from the UIMessage parts array */
export type MessagePart = MessageParts[number];

/**
 * Parsed chunk data from an AI SDK stream event.
 * This is the JSON-parsed body of a CF_AGENT_USE_CHAT_RESPONSE message,
 * or the `data:` payload of an SSE line.
 */
export type StreamChunkData = {
  type: string;
  id?: string;
  delta?: string;
  text?: string;
  mediaType?: string;
  url?: string;
  sourceId?: string;
  title?: string;
  filename?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  inputTextDelta?: string;
  output?: unknown;
  state?: string;
  errorText?: string;
  /** When true, the output is preliminary (may be updated by a later chunk) */
  preliminary?: boolean;
  providerMetadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Applies a stream chunk to a mutable parts array, building up the message
 * incrementally. Returns true if the chunk was handled, false if it was
 * an unrecognized type (caller may handle it with additional logic).
 *
 * Handles all common chunk types that both server and client need:
 * - text-start / text-delta / text-end
 * - reasoning-start / reasoning-delta / reasoning-end
 * - file
 * - source-url / source-document
 * - tool-input-start / tool-input-delta / tool-input-available / tool-input-error
 * - tool-output-available / tool-output-error
 * - step-start (aliased from start-step)
 *
 * @param parts - The mutable parts array to update
 * @param chunk - The parsed stream chunk data
 * @returns true if handled, false if the chunk type is not recognized
 */
export function applyChunkToParts(
  parts: MessagePart[],
  chunk: StreamChunkData
): boolean {
  switch (chunk.type) {
    case "text-start": {
      parts.push({
        type: "text",
        text: "",
        state: "streaming"
      } as MessagePart);
      return true;
    }

    case "text-delta": {
      const lastTextPart = findLastPartByType(parts, "text");
      if (lastTextPart && lastTextPart.type === "text") {
        (lastTextPart as { text: string }).text += chunk.delta ?? "";
      } else {
        // No text-start received — create a new text part (stream resumption fallback)
        parts.push({
          type: "text",
          text: chunk.delta ?? "",
          state: "streaming"
        } as MessagePart);
      }
      return true;
    }

    case "text-end": {
      const lastTextPart = findLastPartByType(parts, "text");
      if (lastTextPart && "state" in lastTextPart) {
        (lastTextPart as { state: string }).state = "done";
      }
      return true;
    }

    case "reasoning-start": {
      parts.push({
        type: "reasoning",
        text: "",
        state: "streaming"
      } as MessagePart);
      return true;
    }

    case "reasoning-delta": {
      const lastReasoningPart = findLastPartByType(parts, "reasoning");
      if (lastReasoningPart && lastReasoningPart.type === "reasoning") {
        (lastReasoningPart as { text: string }).text += chunk.delta ?? "";
      } else {
        // No reasoning-start received — create a new reasoning part (stream resumption fallback)
        parts.push({
          type: "reasoning",
          text: chunk.delta ?? "",
          state: "streaming"
        } as MessagePart);
      }
      return true;
    }

    case "reasoning-end": {
      const lastReasoningPart = findLastPartByType(parts, "reasoning");
      if (lastReasoningPart && "state" in lastReasoningPart) {
        (lastReasoningPart as { state: string }).state = "done";
      }
      return true;
    }

    case "file": {
      parts.push({
        type: "file",
        mediaType: chunk.mediaType,
        url: chunk.url
      } as MessagePart);
      return true;
    }

    case "source-url": {
      parts.push({
        type: "source-url",
        sourceId: chunk.sourceId,
        url: chunk.url,
        title: chunk.title,
        providerMetadata: chunk.providerMetadata
      } as MessagePart);
      return true;
    }

    case "source-document": {
      parts.push({
        type: "source-document",
        sourceId: chunk.sourceId,
        mediaType: chunk.mediaType,
        title: chunk.title,
        filename: chunk.filename,
        providerMetadata: chunk.providerMetadata
      } as MessagePart);
      return true;
    }

    case "tool-input-start": {
      // Create a tool part in input-streaming state with no input yet.
      // Cross-tab clients see the tool appear immediately with "streaming" indicator.
      parts.push({
        type: `tool-${chunk.toolName}`,
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        state: "input-streaming",
        input: undefined
      } as MessagePart);
      return true;
    }

    case "tool-input-delta": {
      // Update the existing tool part with partial input as it streams in.
      const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
      if (toolPart) {
        (toolPart as Record<string, unknown>).input = chunk.input;
      }
      return true;
    }

    case "tool-input-available": {
      // Finalize the tool input. If tool-input-start was received, update
      // the existing part; otherwise create a new one (for non-streaming tools).
      const existing = findToolPartByCallId(parts, chunk.toolCallId);
      if (existing) {
        const p = existing as Record<string, unknown>;
        p.state = "input-available";
        p.input = chunk.input;
      } else {
        parts.push({
          type: `tool-${chunk.toolName}`,
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          state: "input-available",
          input: chunk.input
        } as MessagePart);
      }
      return true;
    }

    case "tool-input-error": {
      // Tool input parsing failed. Update existing part or create one.
      const existing = findToolPartByCallId(parts, chunk.toolCallId);
      if (existing) {
        const p = existing as Record<string, unknown>;
        p.state = "output-error";
        p.errorText = chunk.errorText;
        p.input = chunk.input;
      } else {
        parts.push({
          type: `tool-${chunk.toolName}`,
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          state: "output-error",
          input: chunk.input,
          errorText: chunk.errorText
        } as MessagePart);
      }
      return true;
    }

    case "tool-output-available": {
      // Update existing tool part with output.
      // Supports `preliminary: true` for streaming tool results —
      // the output may be updated by a subsequent chunk.
      const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
      if (toolPart) {
        const p = toolPart as Record<string, unknown>;
        p.state = "output-available";
        p.output = chunk.output;
        if (chunk.preliminary !== undefined) {
          p.preliminary = chunk.preliminary;
        }
      }
      return true;
    }

    case "tool-output-error": {
      // Tool execution failed. Update the existing tool part.
      const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
      if (toolPart) {
        const p = toolPart as Record<string, unknown>;
        p.state = "output-error";
        p.errorText = chunk.errorText;
      }
      return true;
    }

    // Both "step-start" (client convention) and "start-step" (server convention)
    case "step-start":
    case "start-step": {
      parts.push({ type: "step-start" } as MessagePart);
      return true;
    }

    default:
      return false;
  }
}

/**
 * Finds the last part in the array matching the given type.
 * Searches from the end for efficiency (the part we want is usually recent).
 */
function findLastPartByType(
  parts: MessagePart[],
  type: string
): MessagePart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === type) {
      return parts[i];
    }
  }
  return undefined;
}

/**
 * Finds a tool part by its toolCallId.
 * Searches from the end since the tool part is usually recent.
 */
function findToolPartByCallId(
  parts: MessagePart[],
  toolCallId: string | undefined
): MessagePart | undefined {
  if (!toolCallId) return undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if ("toolCallId" in p && p.toolCallId === toolCallId) {
      return p;
    }
  }
  return undefined;
}
