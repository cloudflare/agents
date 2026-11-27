/**
 * A stored reply as the chunks that build it again.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { UIMessage, UIMessageChunk } from "ai";

/**
 * The chunks that build `message` again: a start, each part as the chunks
 * a model call sends for it (settled), and a finish. What a parent replays
 * of a turn that settled, whose stream the cutover dropped: the stored
 * reply is its record.
 */
export function chunksOfMessage(message: UIMessage): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [{ type: "start", messageId: message.id }];
  message.parts.forEach((part, index) => {
    const id = `${message.id}-${index}`;
    if (part.type === "step-start") {
      chunks.push({ type: "start-step" });
    } else if (part.type === "text") {
      chunks.push(
        { type: "text-start", id },
        { type: "text-delta", id, delta: part.text },
        { type: "text-end", id }
      );
    } else if (part.type === "reasoning") {
      chunks.push(
        { type: "reasoning-start", id },
        { type: "reasoning-delta", id, delta: part.text },
        { type: "reasoning-end", id }
      );
    } else if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const tool = part as {
        type: string;
        toolName?: string;
        toolCallId: string;
        state: string;
        input?: unknown;
        output?: unknown;
        errorText?: string;
      };
      const toolName =
        tool.type === "dynamic-tool"
          ? (tool.toolName ?? "")
          : tool.type.slice("tool-".length);
      chunks.push({
        type: "tool-input-available",
        toolCallId: tool.toolCallId,
        toolName,
        input: tool.input,
        ...(tool.type === "dynamic-tool" ? { dynamic: true } : {})
      } as UIMessageChunk);
      if (tool.state === "output-available") {
        chunks.push({
          type: "tool-output-available",
          toolCallId: tool.toolCallId,
          output: tool.output
        } as UIMessageChunk);
      } else if (tool.state === "output-error") {
        chunks.push({
          type: "tool-output-error",
          toolCallId: tool.toolCallId,
          errorText: tool.errorText ?? ""
        } as UIMessageChunk);
      }
    } else if (part.type.startsWith("data-")) {
      chunks.push(part as UIMessageChunk);
    } else if (part.type === "file") {
      chunks.push({
        type: "file",
        url: part.url,
        mediaType: part.mediaType
      });
    }
  });
  chunks.push({ type: "finish" });
  return chunks;
}
