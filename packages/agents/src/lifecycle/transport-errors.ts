// Internal helpers for classifying WebSocket transport errors.
// Not re-exported from the package entry point; imported by `index.ts` and
// exercised directly by `tests/transport-errors.test.ts`.

/** Standard `WebSocket.readyState` values. */
const CLOSING = 2;
const CLOSED = 3;

/**
 * A retryable transport-teardown error ("Network connection lost" /
 * "WebSocket peer disconnected") that fires on a connection which is already
 * CLOSING/CLOSED is just the socket going away during or right after the close
 * handshake - not an application error. Surfacing it via `onError` spams logs
 * on every abrupt client disconnect, and even on clean closes when the peer
 * tears down its transport before our reciprocal Close frame lands. Suppress
 * it in that specific case only; genuine mid-connection (OPEN) errors still
 * reach `onError`.
 *
 * Detection prefers the structured `retryable` flag over message text so it
 * stays correct across `enhanced-error-serialization` (compat date
 * >= 2026-04-21), with a substring fallback for older error shapes.
 */
export function isBenignTeardownError(
  ws: { readyState?: number },
  error: unknown
): boolean {
  const state = ws.readyState;
  if (state !== CLOSING && state !== CLOSED) return false;
  if (typeof error !== "object" || error === null) return false;
  const typed = error as { retryable?: boolean; message?: unknown };
  if (typed.retryable === true) return true;
  const message = typeof typed.message === "string" ? typed.message : "";
  return /Network connection lost|WebSocket peer disconnected/i.test(message);
}
