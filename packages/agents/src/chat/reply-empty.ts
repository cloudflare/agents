/**
 * Whether a reply holds nothing, shared by the server-side repair and the
 * client: neither keeps such a reply.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

/**
 * Whether a reply holds nothing: nothing a client can show and nothing a
 * model request can carry. That is an assistant message with no parts, or
 * with only `step-start` markers and text or reasoning parts that have no
 * text. A reply cut off while the model was still reasoning is left like
 * this once `stripTrailingReasoning` has run.
 *
 * Such a reply is not stored, and one that is stored is removed: a client
 * draws it as an empty bubble, and nothing can continue it. A client drops
 * one a stream opened and ended with nothing in it
 * ({@link dropEmptyReply}).
 */
export function replyIsEmpty(message: {
  role: string;
  parts: ReadonlyArray<unknown>;
}): boolean {
  return (
    message.role === "assistant" &&
    message.parts.every((part) => {
      const record = part as { type?: unknown; text?: unknown };
      if (record.type === "step-start") return true;
      return (
        (record.type === "text" || record.type === "reasoning") &&
        (typeof record.text !== "string" || record.text.length === 0)
      );
    })
  );
}

/**
 * `messages` without the reply `messageId` when it holds nothing
 * ({@link replyIsEmpty}). A stream opens the message its first frame names,
 * and one that ends with no content (a continuation stopped before its
 * model wrote anything) leaves it empty. The server stores no such reply,
 * so a tab drops it when the stream ends.
 *
 * @returns `messages` itself when there is nothing to drop.
 */
export function dropEmptyReply<
  TMessage extends { id: string; role: string; parts: ReadonlyArray<unknown> }
>(messages: TMessage[], messageId: string | undefined): TMessage[] {
  if (messageId === undefined) return messages;
  const at = messages.findIndex((message) => message.id === messageId);
  if (at < 0 || !replyIsEmpty(messages[at])) return messages;
  return [...messages.slice(0, at), ...messages.slice(at + 1)];
}
