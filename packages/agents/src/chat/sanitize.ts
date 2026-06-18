/**
 * Message sanitization and row-size enforcement utilities.
 *
 * Shared by @cloudflare/ai-chat and @cloudflare/think to ensure persistence
 * hygiene: stripping ephemeral provider metadata and compacting
 * oversized messages before writing to SQLite.
 */

import type { ProviderMetadata, ReasoningUIPart, UIMessage } from "ai";
import { truncateToolOutput } from "./tool-output-truncation";

const textEncoder = new TextEncoder();

/** Maximum serialized message size before compaction (bytes). 1.8MB with headroom below SQLite's 2MB limit. */
export const ROW_MAX_BYTES = 1_800_000;

/** Measure UTF-8 byte length of a string. */
export function byteLength(s: string): number {
  return textEncoder.encode(s).byteLength;
}

/**
 * Sanitize a message for persistence by removing ephemeral provider-specific
 * data that should not be stored or sent back in subsequent requests.
 *
 * 1. Strips OpenAI ephemeral fields (itemId, reasoningEncryptedContent)
 * 2. Filters truly empty reasoning parts (no text, no remaining providerMetadata)
 */
export function sanitizeMessage(message: UIMessage): UIMessage {
  const strippedParts = message.parts.map((part) => {
    let sanitizedPart = part;

    if (
      "providerMetadata" in sanitizedPart &&
      sanitizedPart.providerMetadata &&
      typeof sanitizedPart.providerMetadata === "object" &&
      "openai" in sanitizedPart.providerMetadata
    ) {
      sanitizedPart = stripOpenAIMetadata(sanitizedPart, "providerMetadata");
    }

    if (
      "callProviderMetadata" in sanitizedPart &&
      sanitizedPart.callProviderMetadata &&
      typeof sanitizedPart.callProviderMetadata === "object" &&
      "openai" in sanitizedPart.callProviderMetadata
    ) {
      sanitizedPart = stripOpenAIMetadata(
        sanitizedPart,
        "callProviderMetadata"
      );
    }

    return sanitizedPart;
  }) as UIMessage["parts"];

  const sanitizedParts = strippedParts.filter((part) => {
    if (part.type === "reasoning") {
      const reasoningPart = part as ReasoningUIPart;
      if (!reasoningPart.text || reasoningPart.text.trim() === "") {
        if (
          "providerMetadata" in reasoningPart &&
          reasoningPart.providerMetadata &&
          typeof reasoningPart.providerMetadata === "object" &&
          Object.keys(reasoningPart.providerMetadata).length > 0
        ) {
          return true;
        }
        return false;
      }
    }
    return true;
  });

  return { ...message, parts: sanitizedParts };
}

function stripOpenAIMetadata<T extends UIMessage["parts"][number]>(
  part: T,
  metadataKey: "providerMetadata" | "callProviderMetadata"
): T {
  const metadata = (part as Record<string, unknown>)[metadataKey] as {
    openai?: Record<string, unknown>;
    [key: string]: unknown;
  };

  if (!metadata?.openai) return part;

  const {
    itemId: _itemId,
    reasoningEncryptedContent: _rec,
    ...restOpenai
  } = metadata.openai;

  const hasOtherOpenaiFields = Object.keys(restOpenai).length > 0;
  const { openai: _openai, ...restMetadata } = metadata;

  let newMetadata: ProviderMetadata | undefined;
  if (hasOtherOpenaiFields) {
    newMetadata = { ...restMetadata, openai: restOpenai } as ProviderMetadata;
  } else if (Object.keys(restMetadata).length > 0) {
    newMetadata = restMetadata as ProviderMetadata;
  }

  const { [metadataKey]: _oldMeta, ...restPart } = part as Record<
    string,
    unknown
  >;

  if (newMetadata) {
    return { ...restPart, [metadataKey]: newMetadata } as T;
  }
  return restPart as T;
}

/** Optional hooks for {@link enforceRowSizeLimit}. */
export interface EnforceRowSizeLimitOptions {
  /**
   * Optional logger invoked when a message has to be compacted/truncated. The
   * package supplies its own log prefix (log prefixes stay package-specific).
   */
  warn?: (message: string) => void;
}

/**
 * Enforce SQLite row size limits by compacting tool outputs and text parts
 * when a serialized message exceeds the safety threshold (1.8MB). Shared by
 * `@cloudflare/ai-chat` and `@cloudflare/think` so both compact identically.
 *
 * Compaction strategy:
 * 1. Compact tool outputs over 1KB with {@link truncateToolOutput}, preserving
 *    the structured output shape, and annotate `metadata.compactedToolOutputs`
 *    with the compacted tool-call IDs.
 * 2. If still too big, truncate text parts from oldest to newest, annotating
 *    `metadata.compactedTextParts` with the truncated part indices.
 */
export function enforceRowSizeLimit(
  message: UIMessage,
  options?: EnforceRowSizeLimitOptions
): UIMessage {
  let json = JSON.stringify(message);
  let size = byteLength(json);
  if (size <= ROW_MAX_BYTES) return message;

  if (message.role !== "assistant") {
    options?.warn?.(
      `Non-assistant message ${message.id} is ${size} bytes, exceeds row ` +
        `limit. Truncating text parts.`
    );
    return truncateTextParts(message);
  }

  options?.warn?.(
    `Message ${message.id} is ${size} bytes, compacting tool outputs to fit ` +
      `SQLite row limit`
  );

  const compactedToolCallIds: string[] = [];
  const compactedParts = message.parts.map((part) => {
    if (
      "output" in part &&
      "toolCallId" in part &&
      "state" in part &&
      part.state === "output-available"
    ) {
      const output = (part as { output: unknown }).output;
      const truncated = truncateToolOutput(output, 1000);
      if (truncated.truncated) {
        compactedToolCallIds.push(part.toolCallId as string);
        return {
          ...part,
          output: truncated.output
        };
      }
    }
    return part;
  }) as UIMessage["parts"];

  const result: UIMessage = { ...message, parts: compactedParts };
  if (compactedToolCallIds.length > 0) {
    result.metadata = {
      ...(result.metadata ?? {}),
      compactedToolOutputs: compactedToolCallIds
    };
  }

  json = JSON.stringify(result);
  size = byteLength(json);
  if (size <= ROW_MAX_BYTES) return result;

  options?.warn?.(
    `Message ${message.id} still ${size} bytes after tool compaction, ` +
      `truncating text parts`
  );
  return truncateTextParts(result);
}

function truncateTextParts(message: UIMessage): UIMessage {
  const compactedTextPartIndices: number[] = [];
  const parts = [...message.parts];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === "text" && "text" in part) {
      const text = (part as { text: string }).text;
      if (text.length > 1000) {
        compactedTextPartIndices.push(i);
        parts[i] = {
          ...part,
          text:
            `[Text truncated for storage (${text.length} chars). ` +
            `First 500 chars: ${text.slice(0, 500)}...]`
        } as UIMessage["parts"][number];

        const candidate = { ...message, parts };
        if (byteLength(JSON.stringify(candidate)) <= ROW_MAX_BYTES) {
          break;
        }
      }
    }
  }

  const result: UIMessage = { ...message, parts };
  if (compactedTextPartIndices.length > 0) {
    result.metadata = {
      ...(result.metadata ?? {}),
      compactedTextParts: compactedTextPartIndices
    };
  }
  return result;
}
