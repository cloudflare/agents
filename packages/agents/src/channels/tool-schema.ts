import type { ChannelMessage } from "./channel";

export const channelMessageJsonSchema: {
  type: "object";
  properties: {
    title: { type: "string"; description: string };
    markdown: { type: "string"; minLength: number; description: string };
  };
  required: string[];
  additionalProperties: false;
} = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Optional title or topic for the message"
    },
    markdown: {
      type: "string",
      minLength: 1,
      description: "Message content formatted as Markdown"
    }
  },
  required: ["markdown"],
  additionalProperties: false
};

export function parseChannelMessage(value: unknown): ChannelMessage {
  if (typeof value === "object" && value !== null) {
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.markdown === "string" &&
      candidate.markdown.length > 0 &&
      (candidate.title === undefined || typeof candidate.title === "string")
    ) {
      return {
        ...(typeof candidate.title === "string"
          ? { title: candidate.title }
          : {}),
        markdown: candidate.markdown
      };
    }
  }

  throw new Error(
    "Expected an optional string title and a non-empty Markdown string"
  );
}
