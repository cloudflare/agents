/**
 * Connection I/O — shared WebSocket send guard for chat agents.
 *
 * `@internal` — sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API. See
 * `design/rfc-chat-recovery-foundation.md`.
 *
 * Both packages (and `continuation-state`) hand-maintained byte-identical
 * copies of `sendIfOpen` / `isWebSocketClosedSendError`; this is the single
 * shared implementation.
 */

/**
 * Minimal connection interface for sending WebSocket messages. Matches the
 * `Connection` type from `agents` without importing it: `Connection` extends
 * `WebSocket` with its own `send` overload, so it is structurally assignable.
 */
export interface ChatConnection {
  readonly id: string;
  send(message: string): void;
}

/**
 * Send a message on a connection, swallowing the specific
 * "send after close" error a racing disconnect produces. Returns `true` if the
 * send went out, `false` if the socket was already closed. Any other error
 * rethrows.
 */
export function sendIfOpen(
  connection: ChatConnection,
  message: string
): boolean {
  try {
    connection.send(message);
    return true;
  } catch (error) {
    if (isWebSocketClosedSendError(error)) return false;
    throw error;
  }
}

/** Whether an error is the "WebSocket send() after close" `TypeError`. */
export function isWebSocketClosedSendError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes("WebSocket send() after close")
  );
}
