import {
  jsonSchema,
  tool,
  type TextStreamPart,
  type Tool,
  type ToolSet
} from "ai";
import type { ChannelChunk, ChannelMessage, DeliveryResult } from "./channel";
import type { ChannelHost } from "./host";
import type { ChannelMessageSurface } from "./surface";
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

/**
 * Adapt one Host-resolved surface to an AI SDK tool.
 *
 * The caller chooses the key used in its ToolSet and owns model-facing policy
 * such as the description, examples, metadata, and approval requirement.
 */
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

function toChannelChunk(
  part: TextStreamPart<ToolSet>
): ChannelChunk | undefined {
  switch (part.type) {
    case "text-delta":
      return { type: "text", text: part.text };
    case "reasoning-delta":
      return { type: "reasoning", text: part.text };
    case "source":
      return part.sourceType === "url"
        ? {
            type: "source",
            url: part.url,
            ...(part.title !== undefined && { title: part.title })
          }
        : undefined;
    case "tool-call":
      return {
        type: "tool",
        id: part.toolCallId,
        name: part.toolName,
        status: "started"
      };
    case "tool-result":
      return {
        type: "tool",
        id: part.toolCallId,
        name: part.toolName,
        status: "completed"
      };
    case "tool-error":
      return {
        type: "tool",
        id: part.toolCallId,
        name: part.toolName,
        status: "failed"
      };
    default:
      return undefined;
  }
}

/**
 * Project an AI SDK `fullStream` onto neutral Channel chunks.
 *
 * Parts a Channel cannot express are dropped, which keeps provider part
 * shapes out of `ChannelChunk`. An `error` or `abort` part errors the returned
 * stream, so a generation that fails part-way reaches a Channel as the
 * abnormal ending it is rather than as a complete answer.
 */
export function toChannelChunks(
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>
): ReadableStream<ChannelChunk> {
  const parts = fullStream[Symbol.asyncIterator]();
  let sourceClosed = false;

  async function closeSource(reason?: unknown): Promise<void> {
    if (sourceClosed) return;
    sourceClosed = true;
    await parts.return?.(reason);
  }

  return new ReadableStream<ChannelChunk>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await parts.next();
          if (done) {
            sourceClosed = true;
            controller.close();
            return;
          }
          if (value.type === "error") {
            const error =
              value.error instanceof Error
                ? value.error
                : new Error(String(value.error));
            await closeSource().catch(() => {});
            controller.error(error);
            return;
          }
          if (value.type === "abort") {
            const error = new Error(
              value.reason ?? "The generation was aborted"
            );
            await closeSource().catch(() => {});
            controller.error(error);
            return;
          }
          const chunk = toChannelChunk(value);
          if (!chunk) continue;
          controller.enqueue(chunk);
          return;
        }
      } catch (error) {
        await closeSource().catch(() => {});
        controller.error(error);
      }
    },
    cancel: closeSource
  });
}
