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

export interface BurstPlan {
  menu: boolean;
  /** Messages for the model, oldest first. */
  messages: Message[];
  reset: boolean;
}

/**
 * Splits a burst into its control commands and model input. A `/reset` runs
 * first and drops everything sent before it, so only later lines reach the
 * fresh conversation. `/menu` lines are never model input.
 */
export function planBurst(
  message: Message,
  skipped: readonly Message[] = []
): BurstPlan {
  const burst = [...skipped, message];
  let start = 0;
  burst.forEach((entry, index) => {
    if (isResetCommand(entry.text)) {
      start = index + 1;
    }
  });
  const rest = burst.slice(start);
  return {
    menu: rest.some((entry) => isMenuCommand(entry.text)),
    messages: rest.filter((entry) => !isMenuCommand(entry.text)),
    reset: start > 0
  };
}

/**
 * `skipped` holds the earlier messages Chat SDK's `burst` strategy folded into
 * this turn (`context.skipped`). They are rendered oldest first, and a speaker
 * label is only repeated when the author changes.
 */
export function toThinkUserMessage(
  message: Message,
  skipped: readonly Message[] = []
): UIMessage {
  const lines: string[] = [];
  let previousAuthorId: string | undefined;
  for (const entry of [...skipped, message]) {
    const text = stripAskCommand(entry.text).trim() || entry.text.trim();
    if (!text && entry !== message) {
      continue;
    }
    const authorName =
      entry.author.fullName || entry.author.userName || entry.author.userId;
    lines.push(
      authorName && entry.author.userId !== previousAuthorId
        ? `${authorName}: ${text}`
        : text
    );
    previousAuthorId = entry.author.userId;
  }

  return {
    id: `telegram:${message.id}`,
    role: "user",
    parts: [{ type: "text", text: lines.join("\n") }]
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
