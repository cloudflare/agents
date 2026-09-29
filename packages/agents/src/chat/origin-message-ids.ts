/**
 * IDs of the user messages a chat request originated from: the trailing run of
 * user messages in its `messages` (one for a plain send or a regenerate,
 * several when queued sends arrive together). Terminal response frames echo
 * them as `messageIds` (#2280).
 */
export function originMessageIds(messages: unknown): string[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  const ids: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { id?: unknown; role?: unknown } | null;
    if (message?.role !== "user") break;
    if (typeof message.id === "string" && message.id) ids.unshift(message.id);
  }
  return ids.length > 0 ? ids : undefined;
}

/**
 * Return `frame` with `messageIds` added when it is a terminal
 * (`done` or `error`) frame that does not already carry them.
 */
export function withOriginMessageIds<T extends object>(
  frame: T,
  messageIds: string[] | undefined
): T {
  const fields = frame as {
    done?: unknown;
    error?: unknown;
    messageIds?: unknown;
  };
  if (
    !messageIds ||
    fields.messageIds !== undefined ||
    !(fields.done || fields.error)
  ) {
    return frame;
  }
  return { ...frame, messageIds };
}
