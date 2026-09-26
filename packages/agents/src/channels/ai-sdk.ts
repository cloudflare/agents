import {
  jsonSchema,
  tool,
  type TextStreamPart,
  type Tool,
  type ToolSet,
  type UIMessageChunk
} from "ai";
import type { ChannelChunk, ChannelMessage, DeliveryResult } from "./channel";
import type { ChannelHost } from "./host";
import type { ChannelMessageSurface } from "./surface";
import {
  channelChunkToUIChunks,
  finishUIConversion,
  newUIConverterState,
  uiChunkToChannelChunk
} from "./ai-sdk-stream";
import { channelMessageJsonSchema, parseChannelMessage } from "./tool-schema";

type SendMessageTool = Tool<ChannelMessage, DeliveryResult>;

/** Model-facing options controlled by the caller creating the tool. */
export type CreateSendMessageToolOptions = Pick<
  SendMessageTool,
  | "description"
  | "inputExamples"
  | "metadata"
  | "needsApproval"
  | "providerOptions"
  | "strict"
>;

const channelMessageSchema = jsonSchema<ChannelMessage>(
  channelMessageJsonSchema,
  {
    validate(value) {
      try {
        return { success: true, value: parseChannelMessage(value) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error : new Error(String(error))
        };
      }
    }
  }
);

/** Adapt one Host-resolved surface to an AI SDK tool. */
export function createSendMessageTool(
  host: ChannelHost,
  surface: ChannelMessageSurface,
  options: CreateSendMessageToolOptions = {}
): Tool<ChannelMessage, DeliveryResult> {
  return tool({
    ...options,
    inputSchema: channelMessageSchema,
    execute: (message) => host.deliver(surface, message)
  });
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined)
  ) as T;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileUrl(file: { base64: string; mediaType: string }): string {
  return `data:${file.mediaType};base64,${file.base64}`;
}

function toChannelChunk(
  part: TextStreamPart<ToolSet>
): ChannelChunk | undefined {
  switch (part.type) {
    case "start":
      return { type: "message-start" };
    case "finish":
      return { type: "message-finish", finishReason: part.finishReason };
    case "start-step":
      return { type: "step-start" };
    case "finish-step":
      return { type: "step-finish" };
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "reasoning-end":
    case "custom":
      return defined(part);
    case "text-delta":
      return defined({
        type: "text" as const,
        id: part.id,
        text: part.text,
        providerMetadata: part.providerMetadata
      });
    case "reasoning-delta":
      return defined({
        type: "reasoning" as const,
        id: part.id,
        text: part.text,
        providerMetadata: part.providerMetadata
      });
    case "tool-input-start":
      return defined({
        type: "tool-input-start" as const,
        toolCallId: part.id,
        toolName: part.toolName,
        title: part.title,
        providerExecuted: part.providerExecuted,
        providerMetadata: part.providerMetadata,
        toolMetadata: part.toolMetadata,
        dynamic: part.dynamic
      });
    case "tool-input-delta":
      return {
        type: "tool-input-delta",
        toolCallId: part.id,
        delta: part.delta
      };
    case "tool-input-end":
      return undefined;
    case "tool-call": {
      const context = defined({
        providerExecuted: part.providerExecuted,
        providerMetadata: part.providerMetadata,
        toolMetadata: part.toolMetadata,
        dynamic: part.dynamic
      });
      if (part.dynamic && part.invalid) {
        return defined({
          type: "tool-input-error" as const,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          errorText: errorText(part.error),
          title: part.title,
          ...context
        });
      }
      return defined({
        type: "tool-input-available" as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        title: part.title,
        ...context
      });
    }
    case "tool-result":
      return defined({
        type: "tool-output-available" as const,
        toolCallId: part.toolCallId,
        output: part.output,
        providerExecuted: part.providerExecuted,
        providerMetadata: part.providerMetadata,
        toolMetadata: part.toolMetadata,
        dynamic: part.dynamic,
        preliminary: part.preliminary
      });
    case "tool-error":
      return defined({
        type: "tool-output-error" as const,
        toolCallId: part.toolCallId,
        errorText: errorText(part.error),
        providerExecuted: part.providerExecuted,
        providerMetadata: part.providerMetadata,
        toolMetadata: part.toolMetadata,
        dynamic: part.dynamic
      });
    case "tool-output-denied":
      return { type: "tool-output-denied", toolCallId: part.toolCallId };
    case "tool-approval-request":
      return defined({
        type: "tool-approval-request" as const,
        approvalId: part.approvalId,
        toolCallId: part.toolCall.toolCallId,
        isAutomatic: part.isAutomatic,
        signature: part.signature
      });
    case "tool-approval-response":
      return defined({
        type: "tool-approval-response" as const,
        approvalId: part.approvalId,
        approved: part.approved,
        reason: part.reason,
        providerExecuted: part.providerExecuted,
        providerMetadata: part.toolCall.providerMetadata
      });
    case "source":
      return part.sourceType === "url"
        ? defined({
            type: "source" as const,
            id: part.id,
            url: part.url,
            title: part.title,
            providerMetadata: part.providerMetadata
          })
        : defined({
            type: "source-document" as const,
            id: part.id,
            mediaType: part.mediaType,
            title: part.title,
            filename: part.filename,
            providerMetadata: part.providerMetadata
          });
    case "file":
    case "reasoning-file":
      return defined({
        type: part.type,
        url: fileUrl(part.file),
        mediaType: part.file.mediaType,
        providerMetadata: part.providerMetadata
      });
    case "raw":
      return undefined;
    case "error":
    case "abort":
      return undefined;
  }
}

function iteratorStream<TSource, TOutput>(
  source: AsyncIterable<TSource>,
  convert: (value: TSource) => TOutput | TOutput[] | undefined
): ReadableStream<TOutput> {
  const iterator = source[Symbol.asyncIterator]();
  let sourceClosed = false;
  let pending: TOutput[] = [];

  async function closeSource(reason?: unknown): Promise<void> {
    if (sourceClosed) return;
    sourceClosed = true;
    await iterator.return?.(reason);
  }

  return new ReadableStream<TOutput>({
    async pull(controller) {
      try {
        while (true) {
          if (sourceClosed) return;
          const next = pending.shift();
          if (next !== undefined) {
            if (sourceClosed) return;
            controller.enqueue(next);
            return;
          }
          const result = await iterator.next();
          if (sourceClosed) return;
          if (result.done) {
            sourceClosed = true;
            controller.close();
            return;
          }
          const converted = convert(result.value);
          if (sourceClosed) return;
          if (converted === undefined) continue;
          pending = Array.isArray(converted) ? converted : [converted];
        }
      } catch (error) {
        await closeSource().catch(() => {});
        controller.error(error);
      }
    },
    cancel: closeSource
  });
}

/** Convert an AI SDK full stream without discarding its rich neutral parts. */
export function toChannelChunks(
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>
): ReadableStream<ChannelChunk> {
  return iteratorStream(fullStream, (part) => {
    if (part.type === "error") {
      throw part.error instanceof Error
        ? part.error
        : new Error(String(part.error));
    }
    if (part.type === "abort") {
      throw new Error(part.reason ?? "The generation was aborted");
    }
    return toChannelChunk(part);
  });
}

/** Convert an AI SDK UI stream into neutral Channel chunks. */
export function fromUIMessageStream(
  stream: AsyncIterable<UIMessageChunk>
): ReadableStream<ChannelChunk> {
  return iteratorStream(stream, (chunk) => {
    const converted = uiChunkToChannelChunk(chunk);
    if (converted instanceof Error) throw converted;
    return converted;
  });
}

/** Convert neutral Channel chunks into an AI SDK UI stream. */
export function toUIMessageStream(
  stream: ReadableStream<ChannelChunk>
): ReadableStream<UIMessageChunk> {
  const state = newUIConverterState();
  const reader = stream.getReader();
  let finalized = false;

  function releaseReader(): void {
    if (finalized) return;
    finalized = true;
    reader.releaseLock();
  }

  const source: AsyncIterable<ChannelChunk> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          try {
            const result = await reader.read();
            if (result.done) releaseReader();
            return result;
          } catch (error) {
            releaseReader();
            throw error;
          }
        },
        async return(value?: unknown) {
          try {
            await reader.cancel(value);
          } finally {
            releaseReader();
          }
          return { done: true, value: undefined as never };
        }
      };
    }
  };
  const converted = iteratorStream(source, (chunk) =>
    channelChunkToUIChunks(chunk, state)
  );
  const convertedReader = converted.getReader();
  let ending = false;
  let finalChunks: UIMessageChunk[] = [];

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        if (ending) {
          const final = finalChunks.shift();
          if (final !== undefined) {
            controller.enqueue(final);
          } else {
            convertedReader.releaseLock();
            controller.close();
          }
          return;
        }
        const result = await convertedReader.read();
        if (!result.done) {
          controller.enqueue(result.value);
          return;
        }
        ending = true;
        finalChunks = finishUIConversion(state);
        const final = finalChunks.shift();
        if (final !== undefined) {
          controller.enqueue(final);
        } else {
          convertedReader.releaseLock();
          controller.close();
        }
      } catch (error) {
        convertedReader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await convertedReader.cancel(reason);
      } finally {
        convertedReader.releaseLock();
      }
    }
  });
}
