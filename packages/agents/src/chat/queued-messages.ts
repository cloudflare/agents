/**
 * Where a tab draws the messages waiting requests hold.
 *
 * A request accepted while another turn runs holds its new user messages
 * until its turn starts (`admissions.ts`). The message list a server sends
 * names them in `queuedMessageIds`, after the transcript. A tab draws them
 * after everything else, a reply that is still streaming included, so its
 * order is the one the transcript will have: `U1, A1, U2`. The list the
 * chat keeps underneath is left as it is: the AI SDK appends a streaming
 * reply after its last message, and moving a queued message past it there
 * would make it append the reply a second time.
 *
 * @internal Used by `useAgentChat`.
 */
export function drawQueuedLast<TMessage extends { id: string }>(
  messages: TMessage[],
  queuedMessageIds: ReadonlySet<string>
): TMessage[] {
  if (queuedMessageIds.size === 0) return messages;
  const queued: TMessage[] = [];
  const rest: TMessage[] = [];
  for (const message of messages) {
    (queuedMessageIds.has(message.id) ? queued : rest).push(message);
  }
  if (queued.length === 0) return messages;
  // Already last: keep the same array.
  if (messages.slice(rest.length).every((m) => queuedMessageIds.has(m.id))) {
    return messages;
  }
  return [...rest, ...queued];
}
