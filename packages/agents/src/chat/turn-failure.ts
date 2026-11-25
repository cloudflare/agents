/**
 * How a chat turn that failed before it streamed is reported, for a client
 * request and for a continuation alike, in `@cloudflare/ai-chat` and
 * `@cloudflare/think`. One order:
 *
 * 1. the host's error hook and events, which give the message;
 * 2. the terminal record, before any frame, so a client that is not
 *    connected right now learns the outcome when it comes back, even if the
 *    object dies right after the frame;
 * 3. the error frame.
 *
 * A failed continuation also owes `onChatResponse` for the assistant message
 * it would have extended. {@link reportTurnFailure} returns that result and
 * the caller delivers it once the turn has left the queue, so a hook that
 * starts a turn of its own (`saveMessages`) is not inside one.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import { CHAT_MESSAGE_TYPES } from "./protocol";

/** A turn that failed before its stream started. */
export interface TurnFailure {
  requestId: string;
  error: unknown;
  /** `true` for a continuation turn, `false` for a client request. */
  continuation: boolean;
  /**
   * For a client request: `"persist"` until its messages are stored, then
   * `"turn"`. A continuation is always `"turn"`.
   */
  stage?: "persist" | "turn";
}

/** The error frame of a turn that failed before it streamed. */
export interface TurnErrorFrame {
  type: typeof CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
  id: string;
  body: string;
  done: true;
  error: true;
  continuation?: true;
}

/** The `onChatResponse` result of a continuation that failed. */
export interface TurnFailureResult<TMessage> {
  message: TMessage;
  requestId: string;
  continuation: true;
  status: "error";
  error: string;
}

/** How a host tells its clients and its app that a turn failed. */
export interface TurnFailureHost<TMessage> {
  /**
   * Observe the failure (the host's error hook and events) and return the
   * message clients see.
   */
  describe(failure: TurnFailure): string;
  /** Store the terminal record a reconnecting client replays. */
  recordTerminal(requestId: string, message: string): Promise<void>;
  /** Send `frame` to every client. */
  broadcast(frame: TurnErrorFrame): void;
  /**
   * Deliver `onChatResponse` for the assistant message a failed
   * continuation would have extended. Called after the turn left the queue.
   */
  respond(result: TurnFailureResult<TMessage>): void | Promise<void>;
}

/**
 * Report a turn that failed before it streamed: describe, record, frame, in
 * that order.
 *
 * @param messages - The stored transcript, oldest first.
 * @returns For a continuation with an assistant message to extend, the
 *   `onChatResponse` result the caller delivers after the turn left the
 *   queue (`host.respond`). Otherwise `undefined`.
 */
export async function reportTurnFailure<TMessage>(
  messages: ReadonlyArray<{ role: string }>,
  host: TurnFailureHost<TMessage>,
  failure: TurnFailure
): Promise<TurnFailureResult<TMessage> | undefined> {
  const { requestId, continuation } = failure;
  const message = host.describe(failure);
  await host.recordTerminal(requestId, message).catch((recordError) => {
    console.error("[chat] failed to record a turn failure:", recordError);
  });
  host.broadcast({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
    id: requestId,
    body: message,
    done: true,
    error: true,
    ...(continuation && { continuation: true as const })
  });
  if (!continuation) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    return {
      // SAFETY: the host's transcript holds the host's message type.
      message: messages[i] as TMessage,
      requestId,
      continuation: true,
      status: "error",
      error: message
    };
  }
  return undefined;
}
