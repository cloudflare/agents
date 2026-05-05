/**
 * Shared message builder for reconstructing UIMessage parts from stream chunks.
 *
 * Used by both @cloudflare/ai-chat (server + client) and @cloudflare/think
 * to avoid duplicating the chunk-type switch/case logic.
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
  /** Approval ID for tools with needsApproval */
  approvalId?: string;
  providerMetadata?: Record<string, unknown>;
  /** Whether the tool was executed by the provider (e.g. Gemini code execution) */
  providerExecuted?: boolean;
  /** Payload for data-* parts (developer-defined typed JSON) */
  data?: unknown;
  /** When true, data parts are ephemeral and not persisted to message.parts */
  transient?: boolean;
  /** Message ID assigned by the server at stream start */
  messageId?: string;
  /** Per-message metadata attached by start/finish/message-metadata chunks */
  messageMetadata?: unknown;
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
 * - data-* (developer-defined typed JSON blobs)
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
        mergeProviderMetadata(lastReasoningPart, chunk.providerMetadata);
      } else {
        // No reasoning-start received — create a new reasoning part (stream resumption fallback)
        parts.push({
          type: "reasoning",
          text: chunk.delta ?? "",
          state: "streaming",
          ...(chunk.providerMetadata != null
            ? { providerMetadata: chunk.providerMetadata }
            : {})
        } as MessagePart);
      }
      return true;
    }

    case "reasoning-end": {
      const lastReasoningPart = findLastPartByType(parts, "reasoning");
      if (lastReasoningPart && "state" in lastReasoningPart) {
        (lastReasoningPart as { state: string }).state = "done";
        mergeProviderMetadata(lastReasoningPart, chunk.providerMetadata);
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
      // Idempotent against an existing tool part with the same toolCallId.
      // Some providers (notably the OpenAI Responses API) replay prior
      // tool calls in continuation streams as a fresh `tool-input-start`
      // → `tool-input-delta` → `tool-input-available` →
      // `tool-output-available` sequence carrying the original toolCallId
      // and original output. Without this guard a replay would push a
      // duplicate part into the streaming message *and* clobber the
      // original part's state when the AI SDK's mutate-in-place
      // `updateToolPart` processes the replay on the client (issue #1404).
      // A model that genuinely wants a fresh tool call always emits a
      // new toolCallId, so an existing match is never a legitimate
      // "start over".
      const existing = findToolPartByCallId(parts, chunk.toolCallId);
      if (existing) {
        return true;
      }
      parts.push({
        type: `tool-${chunk.toolName}`,
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        state: "input-streaming",
        input: undefined,
        ...(chunk.providerExecuted != null
          ? { providerExecuted: chunk.providerExecuted }
          : {}),
        ...(chunk.providerMetadata != null
          ? { callProviderMetadata: chunk.providerMetadata }
          : {}),
        ...(chunk.title != null ? { title: chunk.title } : {})
      } as MessagePart);
      return true;
    }

    case "tool-input-delta": {
      // Only mutate input while the tool is still actively input-streaming.
      // Deltas arriving after the tool has already advanced (input-available
      // or any terminal state) are provider replay and must not regress
      // a fully-formed input back to a partial one.
      const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
      if (
        toolPart &&
        (toolPart as Record<string, unknown>).state === "input-streaming"
      ) {
        (toolPart as Record<string, unknown>).input = chunk.input;
      }
      return true;
    }

    case "tool-input-available": {
      const existing = findToolPartByCallId(parts, chunk.toolCallId);
      if (existing) {
        const p = existing as Record<string, unknown>;
        // Only advance from the streaming-input phase. Once the tool is
        // already at input-available or any terminal state
        // (output-available, output-error, output-denied,
        // approval-requested, approval-responded), this chunk is a
        // provider replay and must not regress state or overwrite a
        // resolved input/output. See the comment on tool-input-start.
        if (p.state === "input-streaming") {
          p.state = "input-available";
          p.input = chunk.input;
          if (chunk.providerExecuted != null) {
            p.providerExecuted = chunk.providerExecuted;
          }
          if (chunk.providerMetadata != null) {
            p.callProviderMetadata = chunk.providerMetadata;
          }
          if (chunk.title != null) {
            p.title = chunk.title;
          }
        }
        return true;
      }
      parts.push({
        type: `tool-${chunk.toolName}`,
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        state: "input-available",
        input: chunk.input,
        ...(chunk.providerExecuted != null
          ? { providerExecuted: chunk.providerExecuted }
          : {}),
        ...(chunk.providerMetadata != null
          ? { callProviderMetadata: chunk.providerMetadata }
          : {}),
        ...(chunk.title != null ? { title: chunk.title } : {})
      } as MessagePart);
      return true;
    }

    case "tool-input-error": {
      const existing = findToolPartByCallId(parts, chunk.toolCallId);
      if (existing) {
        const p = existing as Record<string, unknown>;
        // First-write-wins: a tool that's already terminal must not be
        // regressed (or re-decided as an error) by a later chunk. A
        // tool-input-error here is either provider replay or a confused
        // upstream — preserve the existing terminal state.
        if (
          p.state === "output-available" ||
          p.state === "output-error" ||
          p.state === "output-denied"
        ) {
          return true;
        }
        p.state = "output-error";
        p.errorText = chunk.errorText;
        p.input = chunk.input;
        if (chunk.providerExecuted != null) {
          p.providerExecuted = chunk.providerExecuted;
        }
        if (chunk.providerMetadata != null) {
          p.callProviderMetadata = chunk.providerMetadata;
        }
      } else {
        parts.push({
          type: `tool-${chunk.toolName}`,
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          state: "output-error",
          input: chunk.input,
          errorText: chunk.errorText,
          ...(chunk.providerExecuted != null
            ? { providerExecuted: chunk.providerExecuted }
            : {}),
          ...(chunk.providerMetadata != null
            ? { callProviderMetadata: chunk.providerMetadata }
            : {})
        } as MessagePart);
      }
      return true;
    }

    case "tool-approval-request": {
      const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
      if (toolPart) {
        const p = toolPart as Record<string, unknown>;
        p.state = "approval-requested";
        p.approval = { id: chunk.approvalId };
      }
      return true;
    }

    case "tool-output-denied": {
      const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
      if (toolPart) {
        const p = toolPart as Record<string, unknown>;
        p.state = "output-denied";
      }
      return true;
    }

    case "tool-output-available": {
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

    default: {
      // https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data
      if (chunk.type.startsWith("data-")) {
        // Transient parts are ephemeral — the AI SDK client fires an onData
        // callback instead of adding them to message.parts. On the server we
        // still broadcast them (so connected clients see them in real time)
        // but skip persisting them into the stored message parts.
        if (chunk.transient) {
          return true;
        }

        // Reconciliation: if a part with the same type AND id already exists,
        // update its data in-place instead of appending a duplicate.
        if (chunk.id != null) {
          const existing = findDataPartByTypeAndId(parts, chunk.type, chunk.id);
          if (existing) {
            (existing as Record<string, unknown>).data = chunk.data;
            return true;
          }
        }

        // Append new data parts to the array directly.
        // Note: `chunk.data` should always be provided — if omitted, the
        // persisted part will have `data: undefined` which JSON.stringify
        // drops, so the part will have no `data` field on reload.
        // The cast is needed because UIMessage["parts"] doesn't include
        // data-* types in its union because they're an open extension point.
        parts.push({
          type: chunk.type,
          ...(chunk.id != null && { id: chunk.id }),
          data: chunk.data
        } as MessagePart);
        return true;
      }

      return false;
    }
  }
}

/**
 * Returns true if `chunk` would be a no-op replay against the already-known
 * `parts` — i.e. some upstream is re-emitting events for a tool call that
 * the message has already advanced past.
 *
 * Used by stream broadcasters to suppress re-broadcasting these chunks to
 * connected clients. AI SDK v6's `updateToolPart` mutates an existing tool
 * part in place when a chunk arrives with a matching `toolCallId`, so a
 * replayed `tool-input-start` would clobber an `output-available` part back
 * to `input-streaming` on the client (issue #1404).
 *
 * Only returns true when re-broadcasting would *visibly regress* state on
 * a v6 client. Safe-by-construction chunk types (e.g. `tool-output-available`
 * carrying the same output the part already has) return false.
 *
 * Conditions:
 * - `tool-input-start` for a `toolCallId` that already exists in `parts`.
 * - `tool-input-delta` for a `toolCallId` whose existing part is no longer
 *   `input-streaming`.
 * - `tool-input-available` for a `toolCallId` whose existing part is no
 *   longer `input-streaming` (i.e. has already advanced to `input-available`
 *   or any terminal state).
 */
export function isReplayChunk(
  parts: MessagePart[],
  chunk: StreamChunkData
): boolean {
  if (
    chunk.type !== "tool-input-start" &&
    chunk.type !== "tool-input-delta" &&
    chunk.type !== "tool-input-available"
  ) {
    return false;
  }
  if (!chunk.toolCallId) return false;
  const existing = findToolPartByCallId(parts, chunk.toolCallId);
  if (!existing) return false;
  if (chunk.type === "tool-input-start") return true;
  const state = (existing as Record<string, unknown>).state;
  return state !== "input-streaming";
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

/**
 * Shallow-merges providerMetadata from a chunk onto an existing part.
 * Preserves any metadata already on the part (e.g. from earlier deltas)
 * while adding new keys from the chunk. This is critical for providers
 * like Anthropic that emit the thinking block signature on reasoning-end.
 */
function mergeProviderMetadata(
  part: MessagePart,
  metadata: Record<string, unknown> | undefined
): void {
  if (metadata == null) return;
  const p = part as Record<string, unknown>;
  p.providerMetadata = {
    ...(p.providerMetadata as Record<string, unknown> | undefined),
    ...metadata
  };
}

/**
 * Finds a data part by its type and id for reconciliation.
 * Data parts use type+id as a composite key so when the same combination
 * is seen again, the existing part's data is updated in-place.
 */
function findDataPartByTypeAndId(
  parts: MessagePart[],
  type: string,
  id: string
): MessagePart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.type === type && "id" in p && (p as { id: string }).id === id) {
      return p;
    }
  }
  return undefined;
}
