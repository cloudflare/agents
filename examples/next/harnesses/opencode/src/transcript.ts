import type { OpenCodeJson, OpenCodeMessage } from "agents/harness/opencode";

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

export type OpenCodeTranscriptMessage = {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "notice";
  readonly parts: readonly OpenCodeMessagePart[];
  readonly timestamp: number;
  readonly error?: string;
};

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
