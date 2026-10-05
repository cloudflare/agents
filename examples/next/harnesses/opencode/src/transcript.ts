import type { OpenCodeJson, OpenCodeMessage } from "agents/harness/opencode";

/**
 * This app's display model for a transcript, the same one the Pi example
 * uses. The harness returns OpenCode's messages, projected; the UI folds
 * them into these, on the server for a snapshot and in the browser for
 * streamed events.
 */
export type OpenCodeMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: OpenCodeJson;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly content: readonly { readonly type: "text"; text: string }[];
      readonly error: boolean;
    };

/** One display-ready message. */
export type OpenCodeTranscriptMessage = {
  /** OpenCode's message id; a tool message takes its call's. */
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "notice";
  readonly parts: readonly OpenCodeMessagePart[];
  readonly timestamp: number;
  readonly error?: string;
};

/**
 * Project one OpenCode message. An assistant message that called tools
 * becomes the message with its calls, then one tool message per finished
 * call with its result, which is how the Pi transcript reads.
 */
export function projectMessage(
  message: OpenCodeMessage
): OpenCodeTranscriptMessage[] {
  if (message.role === "user") {
    return [
      {
        id: message.id,
        role: "user",
        parts: message.parts.flatMap((part) =>
          part.type === "text" ? [{ type: "text", text: part.text }] : []
        ),
        timestamp: message.timestamp
      }
    ];
  }
  const parts: OpenCodeMessagePart[] = [];
  const results: OpenCodeTranscriptMessage[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "reasoning":
        parts.push({ type: "thinking", text: part.text });
        break;
      case "tool":
        parts.push({
          type: "tool-call",
          id: part.id,
          name: part.name,
          arguments: part.input ?? null
        });
        if (part.status === "completed" || part.status === "error") {
          results.push({
            id: `${message.id}:${part.id}`,
            role: "tool",
            parts: [
              {
                type: "tool-result",
                id: part.id,
                name: part.name,
                content: [
                  { type: "text", text: part.error ?? part.output ?? "" }
                ],
                error: part.status === "error"
              }
            ],
            timestamp: message.timestamp
          });
        }
        break;
    }
  }
  return [
    { id: message.id, role: "assistant", parts, timestamp: message.timestamp },
    ...results
  ];
}

export function projectMessages(
  messages: readonly OpenCodeMessage[]
): OpenCodeTranscriptMessage[] {
  return messages.flatMap(projectMessage);
}
