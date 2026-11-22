/**
 * The message body the `merge` submit strategy stores: the user messages
 * that overlapping submits queued, joined into one so the turn that runs
 * answers all of them.
 */

import type { TextUIPart, UIMessage } from "ai";

/**
 * Join user messages into one. Text runs are concatenated, with a blank
 * line between messages; other parts keep their order. The result keeps
 * the last message's id and fields.
 *
 * @throws When `messages` is empty.
 */
export function mergeUserMessages(messages: readonly UIMessage[]): UIMessage {
  const [first, ...rest] = messages;
  if (!first) {
    throw new Error("cannot merge an empty message list");
  }
  const parts: UIMessage["parts"] = [...first.parts];
  for (const message of rest) {
    appendText(parts, "\n\n");
    for (const part of message.parts) {
      if (part.type === "text") {
        appendText(parts, part.text);
      } else {
        parts.push(part);
      }
    }
  }
  const last = messages[messages.length - 1] ?? first;
  return { ...last, parts };
}

/**
 * The transcript with the run of user messages that starts at `start`
 * merged into one message, or `null` when fewer than two are there.
 *
 * @param warn - Told when `start` does not point at a user message.
 */
export function mergeQueuedUserMessages(
  messages: readonly UIMessage[],
  start: number,
  warn: (message: string) => void = console.warn
): UIMessage[] | null {
  let end = start;
  while (messages[end]?.role === "user") {
    end++;
  }
  if (end === start && start < messages.length) {
    warn(
      `merge: expected user messages at index ${start} ` +
        `but found role="${messages[start]?.role}"; skipping merge`
    );
  }
  const queued = messages.slice(start, end);
  if (queued.length < 2) {
    return null;
  }
  return [
    ...messages.slice(0, start),
    mergeUserMessages(queued),
    ...messages.slice(end)
  ];
}

function appendText(parts: UIMessage["parts"], text: string): void {
  if (text.length === 0) {
    return;
  }
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    parts[parts.length - 1] = { ...last, text: last.text + text };
    return;
  }
  const part: TextUIPart = { type: "text", text };
  parts.push(part);
}
