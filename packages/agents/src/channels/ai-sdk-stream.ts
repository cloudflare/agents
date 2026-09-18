import type { UIMessageChunk } from "ai";
import type { ChannelChunk } from "./channel";

function abortError(reason?: string): Error {
  return new Error(reason ?? "The generation was aborted");
}

function copyDefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined)
  ) as T;
}

function isDataChunk(
  chunk: UIMessageChunk
): chunk is Extract<UIMessageChunk, { type: `data-${string}` }> {
  return chunk.type.startsWith("data-") && "data" in chunk;
}

export function uiChunkToChannelChunk(
  chunk: UIMessageChunk
): ChannelChunk | Error {
  switch (chunk.type) {
    case "error":
      return new Error(chunk.errorText);
    case "abort":
      return abortError(chunk.reason);
    case "start":
      return copyDefined({
        type: "message-start" as const,
        messageId: chunk.messageId,
        metadata: chunk.messageMetadata
      });
    case "finish":
      return copyDefined({
        type: "message-finish" as const,
        finishReason: chunk.finishReason,
        metadata: chunk.messageMetadata
      });
    case "message-metadata":
      return { type: "message-metadata", metadata: chunk.messageMetadata };
    case "start-step":
      return { type: "step-start" };
    case "finish-step":
      return { type: "step-finish" };
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "reasoning-end":
    case "custom":
    case "file":
    case "reasoning-file":
      return copyDefined(chunk);
    case "text-delta":
      return copyDefined({
        type: "text" as const,
        id: chunk.id,
        text: chunk.delta,
        providerMetadata: chunk.providerMetadata
      });
    case "reasoning-delta":
      return copyDefined({
        type: "reasoning" as const,
        id: chunk.id,
        text: chunk.delta,
        providerMetadata: chunk.providerMetadata
      });
    case "tool-input-start":
      return copyDefined(chunk);
    case "tool-input-delta":
      return {
        type: "tool-input-delta",
        toolCallId: chunk.toolCallId,
        delta: chunk.inputTextDelta
      };
    case "tool-input-available":
    case "tool-input-error":
    case "tool-approval-request":
    case "tool-approval-response":
    case "tool-output-available":
    case "tool-output-error":
    case "tool-output-denied":
      return copyDefined(chunk);
    case "source-url":
      return copyDefined({
        type: "source" as const,
        id: chunk.sourceId,
        url: chunk.url,
        title: chunk.title,
        providerMetadata: chunk.providerMetadata
      });
    case "source-document":
      return copyDefined({
        type: "source-document" as const,
        id: chunk.sourceId,
        mediaType: chunk.mediaType,
        title: chunk.title,
        filename: chunk.filename,
        providerMetadata: chunk.providerMetadata
      });
    default:
      if (isDataChunk(chunk)) {
        return copyDefined({
          type: "data" as const,
          name: chunk.type.slice("data-".length),
          id: chunk.id,
          data: chunk.data,
          transient: chunk.transient
        });
      }
      throw new Error(`Unknown AI SDK UI event: ${chunkType(chunk)}`);
  }
}

function chunkType(chunk: never): string {
  return String((chunk as { type?: unknown }).type);
}

export type UIConverterState = ReturnType<typeof newUIConverterState>;

let generatedStreamSequence = 0;

function closeImplicitParts(state: UIConverterState): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [];
  if (state.implicitTextId !== undefined) {
    chunks.push({ type: "text-end", id: state.implicitTextId });
    state.activeTextIds.delete(state.implicitTextId);
    state.implicitTextId = undefined;
  }
  if (state.implicitReasoningId !== undefined) {
    chunks.push({ type: "reasoning-end", id: state.implicitReasoningId });
    state.activeReasoningIds.delete(state.implicitReasoningId);
    state.implicitReasoningId = undefined;
  }
  return chunks;
}

function closeOtherImplicitPart(
  state: UIConverterState,
  kind: "text" | "reasoning"
): UIMessageChunk[] {
  if (kind === "text" && state.implicitReasoningId !== undefined) {
    const id = state.implicitReasoningId;
    state.activeReasoningIds.delete(id);
    state.implicitReasoningId = undefined;
    return [{ type: "reasoning-end", id }];
  }
  if (kind === "reasoning" && state.implicitTextId !== undefined) {
    const id = state.implicitTextId;
    state.activeTextIds.delete(id);
    state.implicitTextId = undefined;
    return [{ type: "text-end", id }];
  }
  return [];
}

export function finishUIConversion(state: UIConverterState): UIMessageChunk[] {
  return closeImplicitParts(state);
}

export function channelChunkToUIChunks(
  chunk: ChannelChunk,
  state: UIConverterState
): UIMessageChunk[] {
  switch (chunk.type) {
    case "message-start":
      return [
        copyDefined({
          type: "start" as const,
          messageId: chunk.messageId,
          messageMetadata: chunk.metadata
        })
      ];
    case "message-finish":
      return [
        ...closeImplicitParts(state),
        copyDefined({
          type: "finish" as const,
          finishReason: chunk.finishReason,
          messageMetadata: chunk.metadata
        })
      ];
    case "message-metadata":
      return [{ type: "message-metadata", messageMetadata: chunk.metadata }];
    case "step-start":
      return [...closeImplicitParts(state), { type: "start-step" }];
    case "step-finish":
      return [...closeImplicitParts(state), { type: "finish-step" }];
    case "text-start": {
      if (state.activeTextIds.has(chunk.id)) {
        throw new Error(`Duplicate text-start for ${chunk.id}`);
      }
      const prefix = closeImplicitParts(state);
      state.activeTextIds.add(chunk.id);
      return [...prefix, copyDefined(chunk)];
    }
    case "text-end":
      if (!state.activeTextIds.delete(chunk.id)) {
        throw new Error(`Text end ${chunk.id} has no matching text-start`);
      }
      if (state.implicitTextId === chunk.id) state.implicitTextId = undefined;
      return [copyDefined(chunk)];
    case "text": {
      const prefix = closeOtherImplicitPart(state, "text");
      if (chunk.id !== undefined) {
        if (!state.activeTextIds.has(chunk.id)) {
          throw new Error(`Text delta ${chunk.id} has no matching text-start`);
        }
        return [
          ...prefix,
          copyDefined({
            type: "text-delta" as const,
            id: chunk.id,
            delta: chunk.text,
            providerMetadata: chunk.providerMetadata
          })
        ];
      }
      if (!state.implicitTextId) {
        state.implicitTextId = `${state.prefix}-text-${++state.textSequence}`;
        state.activeTextIds.add(state.implicitTextId);
        prefix.push({ type: "text-start", id: state.implicitTextId });
      }
      return [
        ...prefix,
        { type: "text-delta", id: state.implicitTextId, delta: chunk.text }
      ];
    }
    case "reasoning-start": {
      if (state.activeReasoningIds.has(chunk.id)) {
        throw new Error(`Duplicate reasoning-start for ${chunk.id}`);
      }
      const prefix = closeImplicitParts(state);
      state.activeReasoningIds.add(chunk.id);
      return [...prefix, copyDefined(chunk)];
    }
    case "reasoning-end":
      if (!state.activeReasoningIds.delete(chunk.id)) {
        throw new Error(
          `Reasoning end ${chunk.id} has no matching reasoning-start`
        );
      }
      if (state.implicitReasoningId === chunk.id) {
        state.implicitReasoningId = undefined;
      }
      return [copyDefined(chunk)];
    case "reasoning": {
      const prefix = closeOtherImplicitPart(state, "reasoning");
      if (chunk.id !== undefined) {
        if (!state.activeReasoningIds.has(chunk.id)) {
          throw new Error(
            `Reasoning delta ${chunk.id} has no matching reasoning-start`
          );
        }
        return [
          ...prefix,
          copyDefined({
            type: "reasoning-delta" as const,
            id: chunk.id,
            delta: chunk.text,
            providerMetadata: chunk.providerMetadata
          })
        ];
      }
      if (!state.implicitReasoningId) {
        state.implicitReasoningId = `${state.prefix}-reasoning-${++state.reasoningSequence}`;
        state.activeReasoningIds.add(state.implicitReasoningId);
        prefix.push({ type: "reasoning-start", id: state.implicitReasoningId });
      }
      return [
        ...prefix,
        {
          type: "reasoning-delta",
          id: state.implicitReasoningId,
          delta: chunk.text
        }
      ];
    }
    case "tool":
      return closeImplicitParts(state);
    case "tool-input-start":
      if (state.toolInputIds.has(chunk.toolCallId)) {
        throw new Error(`Duplicate tool-input-start for ${chunk.toolCallId}`);
      }
      state.toolInputIds.add(chunk.toolCallId);
      return [...closeImplicitParts(state), copyDefined(chunk)];
    case "tool-input-delta":
      if (!state.toolInputIds.has(chunk.toolCallId)) {
        throw new Error(
          `Tool input delta ${chunk.toolCallId} has no matching tool-input-start`
        );
      }
      return [
        ...closeImplicitParts(state),
        {
          type: "tool-input-delta",
          toolCallId: chunk.toolCallId,
          inputTextDelta: chunk.delta
        }
      ];
    case "tool-input-available":
    case "tool-input-error":
      state.toolInputIds.delete(chunk.toolCallId);
      return [...closeImplicitParts(state), copyDefined(chunk)];
    case "tool-output-available":
    case "tool-output-error":
    case "tool-output-denied":
    case "tool-approval-request":
    case "tool-approval-response":
    case "file":
    case "reasoning-file":
    case "custom":
      return [...closeImplicitParts(state), copyDefined(chunk)];
    case "source":
      return [
        ...closeImplicitParts(state),
        copyDefined({
          type: "source-url" as const,
          sourceId:
            chunk.id ?? `${state.prefix}-source-${++state.sourceSequence}`,
          url: chunk.url,
          title: chunk.title,
          providerMetadata: chunk.providerMetadata
        })
      ];
    case "source-document":
      return [
        ...closeImplicitParts(state),
        copyDefined({
          type: "source-document" as const,
          sourceId: chunk.id,
          mediaType: chunk.mediaType,
          title: chunk.title,
          filename: chunk.filename,
          providerMetadata: chunk.providerMetadata
        })
      ];
    case "data":
      return [
        ...closeImplicitParts(state),
        copyDefined({
          type: `data-${chunk.name}` as `data-${string}`,
          id: chunk.id,
          data: chunk.data,
          transient: chunk.transient
        })
      ];
    default:
      return assertNever(chunk);
  }
}

function assertNever(value: never): never {
  throw new Error(
    `Unknown Channel event: ${String((value as { type?: unknown }).type)}`
  );
}

export function newUIConverterState() {
  const sequence = ++generatedStreamSequence;
  return {
    prefix: `channel-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2)}`,
    sourceSequence: 0,
    textSequence: 0,
    reasoningSequence: 0,
    implicitTextId: undefined as string | undefined,
    implicitReasoningId: undefined as string | undefined,
    activeTextIds: new Set<string>(),
    activeReasoningIds: new Set<string>(),
    toolInputIds: new Set<string>()
  };
}
