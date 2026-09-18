import type { ChannelClientTool } from "../ingress";
import { isRecord } from "../internal";

export type WebChatRequestBody = {
  messages: unknown[];
  [key: string]: unknown;
};

export type NormalizedWebChatMessage = {
  id: string;
  text: string;
  clientTools?: readonly ChannelClientTool[];
};

/** Remove chat-client field names and malformed schemas at the Channel seam. */
export function normalizeClientTools(value: unknown): ChannelClientTool[] {
  if (!Array.isArray(value)) return [];
  const tools: ChannelClientTool[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
    const name = candidate.name.trim();
    if (!name) continue;
    const inputSchema = candidate.parameters;
    tools.push({
      name,
      ...(typeof candidate.description === "string" && {
        description: candidate.description
      }),
      ...((typeof inputSchema === "boolean" || isRecord(inputSchema)) && {
        inputSchema
      })
    });
  }
  return tools;
}

/** Read the latest user message from an AI SDK useChat request body. */
export function normalizeWebChatRequest(
  body: unknown
): { body: WebChatRequestBody; message: NormalizedWebChatMessage } | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;

  let candidate: unknown;
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (isRecord(message) && message.role === "user") {
      candidate = message;
      break;
    }
  }
  if (!isRecord(candidate)) return null;

  const id = typeof candidate.id === "string" ? candidate.id : undefined;
  if (!id) return null;

  const text = Array.isArray(candidate.parts)
    ? candidate.parts
        .filter(
          (part): part is { type: "text"; text: string } =>
            isRecord(part) &&
            part.type === "text" &&
            typeof part.text === "string"
        )
        .map((part) => part.text)
        .join("")
    : typeof candidate.content === "string"
      ? candidate.content
      : "";

  const clientTools = normalizeClientTools(body.clientTools);
  return {
    body: body as WebChatRequestBody,
    message: {
      id,
      text,
      ...(clientTools.length > 0 && { clientTools })
    }
  };
}
