import type { Message, Thread } from "chat";
import type { UIMessage } from "ai";

const ASK_COMMAND = /^\/ask(?:@\w+)?(?:\s+|$)/i;
const MENU_COMMAND = /^\/menu(?:@\w+)?(?:\s|$)/i;
const RESET_COMMAND = /^\/reset(?:@\w+)?(?:\s|$)/i;

export interface AiRoutingInput {
  isDM: boolean;
  isMention?: boolean;
  text: string;
}

export function conversationNameForThread(thread: Pick<Thread, "id">): string {
  return thread.id;
}

export function isAskCommand(text: string): boolean {
  return ASK_COMMAND.test(text.trim());
}

export function isMenuCommand(text: string): boolean {
  return MENU_COMMAND.test(text.trim());
}

export function isResetCommand(text: string): boolean {
  return RESET_COMMAND.test(text.trim());
}

export function shouldRouteToAi(input: AiRoutingInput): boolean {
  if (isMenuCommand(input.text) || isResetCommand(input.text)) {
    return false;
  }

  if (input.isDM) {
    return true;
  }

  return input.isMention === true || isAskCommand(input.text);
}

export function toThinkUserMessage(message: Message): UIMessage {
  const text = stripAskCommand(message.text).trim() || message.text.trim();
  const authorName =
    message.author.fullName || message.author.userName || message.author.userId;
  const content = authorName ? `${authorName}: ${text}` : text;

  return {
    id: `telegram:${message.id}`,
    role: "user",
    parts: [{ type: "text", text: content }]
  };
}

export function extractLatestAssistantText(
  messages: UIMessage[]
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }

    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();

    if (text) {
      return text;
    }
  }

  return null;
}

function stripAskCommand(text: string): string {
  return text.trim().replace(ASK_COMMAND, "");
}
