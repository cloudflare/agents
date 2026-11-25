import type { StreamChunkData } from "../../chat/message-builder";
import { StreamAccumulator } from "../../chat/stream-accumulator";
import {
  toTranscriptMessage,
  toUIMessage,
  toUIMessageChunk
} from "./ai-sdk-conversion";
import type { ResponseChunk, TranscriptMessage } from "./protocol";

/**
 * Apply a response's chunks to the message it builds or extends, with the
 * chat message builder every other surface uses (`StreamAccumulator`): the
 * message is mapped to its AI SDK form, the chunks applied, and the result
 * mapped back. A client tool call's `owner`, which only Channels carries,
 * is kept from the message and the chunks.
 */
export function applyChunks(
  message: TranscriptMessage,
  chunks: readonly ResponseChunk[]
): TranscriptMessage {
  const owners = new Map<string, string>();
  for (const part of message.parts) {
    if (part.type === "tool" && part.owner !== undefined) {
      owners.set(part.toolCallId, part.owner);
    }
  }
  const existing = toUIMessage(message);
  const accumulator = new StreamAccumulator({
    messageId: message.id,
    continuation: true,
    existingParts: existing.parts,
    ...(message.metadata && { existingMetadata: message.metadata })
  });
  for (const chunk of chunks) {
    if ("owner" in chunk && chunk.owner !== undefined) {
      owners.set(chunk.toolCallId, chunk.owner);
    }
    // SAFETY: StreamChunkData is the loose JSON view of a UI message chunk.
    accumulator.applyChunk(
      toUIMessageChunk(chunk) as unknown as StreamChunkData
    );
  }
  const built = toTranscriptMessage(accumulator.toMessage());
  return {
    ...built,
    role: message.role,
    parts: built.parts.map((part) => {
      const owner =
        part.type === "tool" ? owners.get(part.toolCallId) : undefined;
      return owner === undefined ? part : { ...part, owner };
    })
  };
}
