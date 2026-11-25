/**
 * Where a tab keeps and draws the messages waiting requests hold.
 *
 * A request accepted while another turn runs holds its new user messages
 * until its turn starts (`admissions.ts`). The message list a server sends
 * ends with them and names them in `queuedMessageIds`. A tab keeps them out
 * of the chat's own message list and draws them after it, a reply that is
 * still streaming included, so the order it shows is the one the transcript
 * will have: `U1, A1, U2`.
 *
 * They stay out of the chat's list because the AI SDK writes a streaming
 * reply in place only while it is the last message there, and appends it
 * again otherwise: with a queued message after it, the reply would be drawn
 * twice. The list that comes when the message is stored puts it in the
 * chat's list, once.
 *
 * @internal Used by `useAgentChat`.
 */

/** A message list split into what is stored and what waits. */
export function splitQueuedMessages<TMessage extends { id: string }>(
  messages: readonly TMessage[],
  queuedMessageIds: readonly string[] | undefined
): { stored: TMessage[]; queued: TMessage[] } {
  if (!queuedMessageIds || queuedMessageIds.length === 0) {
    return { stored: [...messages], queued: [] };
  }
  const ids = new Set(queuedMessageIds);
  const stored: TMessage[] = [];
  const queued: TMessage[] = [];
  for (const message of messages) {
    (ids.has(message.id) ? queued : stored).push(message);
  }
  return { stored, queued };
}

/**
 * What a tab draws: the chat's list, then the queued messages. A queued
 * message the chat's list also holds (the tab that sent it added it) is
 * drawn once, after the rest.
 */
export function drawQueuedLast<TMessage extends { id: string }>(
  messages: TMessage[],
  queued: readonly TMessage[]
): TMessage[] {
  if (queued.length === 0) return messages;
  const ids = new Set(queued.map((message) => message.id));
  return [...messages.filter((message) => !ids.has(message.id)), ...queued];
}
