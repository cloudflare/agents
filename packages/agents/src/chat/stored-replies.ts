/**
 * An incoming request never shortens a stored assistant reply.
 *
 * A client posts its whole transcript with every request, and the host
 * stores what it posts. A tab's copy of a reply can be behind the stored
 * one: after a stop mid-text the tab that pressed stop holds one chunk fewer
 * than the server, and a tab that reconnected late can miss the end of a
 * reply. Storing that copy would cut the reply short for every tab and for
 * the model.
 */

import type { UIMessage } from "ai";

/**
 * Replace each incoming assistant message that the stored copy of the same
 * id already covers with the stored copy.
 *
 * The stored copy covers the incoming one when the incoming parts are a
 * prefix of the stored parts, part by part: the same type, a text or
 * reasoning part whose text the stored text starts with, any other part
 * equal. An incoming copy that adds or changes anything (a tool output the
 * client applied, an edit) is not covered and is returned as it is.
 *
 * Run it on a client request's messages only, after
 * {@link reconcileMessages} has resolved their ids. Server writes may
 * shorten a reply on purpose (a repaired transcript, trailing reasoning
 * removed).
 *
 * @param incoming - The client's messages, ids already reconciled.
 * @param stored - The stored transcript.
 */
export function keepStoredReplies(
  incoming: UIMessage[],
  stored: readonly UIMessage[]
): UIMessage[] {
  const storedReplies = new Map<string, UIMessage>();
  for (const message of stored) {
    if (message.role === "assistant") storedReplies.set(message.id, message);
  }
  if (storedReplies.size === 0) return incoming;
  let changed = false;
  const result = incoming.map((message) => {
    if (message.role !== "assistant") return message;
    const storedCopy = storedReplies.get(message.id);
    if (!storedCopy || !covers(storedCopy, message)) return message;
    changed = true;
    return storedCopy;
  });
  return changed ? result : incoming;
}

function covers(stored: UIMessage, incoming: UIMessage): boolean {
  if (incoming.parts.length > stored.parts.length) return false;
  return incoming.parts.every((part, index) =>
    partCovers(
      stored.parts[index] as Record<string, unknown>,
      part as Record<string, unknown>
    )
  );
}

function partCovers(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>
): boolean {
  if (stored.type !== incoming.type) return false;
  if (incoming.type === "text" || incoming.type === "reasoning") {
    return (
      typeof stored.text === "string" &&
      typeof incoming.text === "string" &&
      stored.text.startsWith(incoming.text)
    );
  }
  return stableStringify(stored) === stableStringify(incoming);
}

function stableStringify(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
