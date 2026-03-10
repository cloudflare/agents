/**
 * Shared message builder for reconstructing UIMessage parts from stream chunks.
 *
 * Derived from @cloudflare/ai-chat's message-builder.ts. Copied here to avoid
 * a circular dependency (agents cannot import from @cloudflare/ai-chat).
 *
 * ⚠️ DRIFT RISK: If @cloudflare/ai-chat updates its message builder (e.g. new
 * chunk types), this copy must be updated manually. Consider adding a test that
 * verifies parity between the two implementations.
 *
 * Operates on a mutable parts array for performance (avoids allocating new
 * arrays on every chunk during streaming).
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
  preliminary?: boolean;
  approvalId?: string;
  providerMetadata?: Record<string, unknown>;
  providerExecuted?: boolean;
  data?: unknown;
  transient?: boolean;
  messageId?: string;
  messageMetadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Applies a stream chunk to a mutable parts array, building up the message
 * incrementally. Returns true if the chunk was handled, false if it was
 * an unrecognized type (caller may handle it with additional logic).
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
      const toolPart = findToolPartByCallId(parts, chunk.toolCallId);
      if (toolPart) {
        (toolPart as Record<string, unknown>).input = chunk.input;
      }
      return true;
    }

    case "tool-input-available": {
      const existing = findToolPartByCallId(parts, chunk.toolCallId);
      if (existing) {
        const p = existing as Record<string, unknown>;
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
      } else {
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
      }
      return true;
    }

    case "tool-input-error": {
      const existing = findToolPartByCallId(parts, chunk.toolCallId);
      if (existing) {
        const p = existing as Record<string, unknown>;
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

    case "step-start":
    case "start-step": {
      parts.push({ type: "step-start" } as MessagePart);
      return true;
    }

    default: {
      if (chunk.type.startsWith("data-")) {
        if (chunk.transient) {
          return true;
        }

        if (chunk.id != null) {
          const existing = findDataPartByTypeAndId(parts, chunk.type, chunk.id);
          if (existing) {
            (existing as Record<string, unknown>).data = chunk.data;
            return true;
          }
        }

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
