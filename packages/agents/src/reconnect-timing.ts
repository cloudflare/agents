/**
 * Reconnect timing for the WebSocket clients (`AgentClient`, `useAgent`).
 * Internal: not exported from any entry point.
 */

/**
 * Defaults for PartySocket's handshake timeout and reconnect delays,
 * applied before the caller's options so those win.
 *
 * - `connectionTimeout` 15 s (PartySocket: 4 s). The server returns the
 *   101 only after its startup and `onConnect` finish; a 101 later than
 *   the timeout is never connected, the client retries and gives up the
 *   same way every time.
 * - `minReconnectionDelay` picked per client between 1 and 5 s
 *   (PartySocket: a fixed 3 s). A reset of the object drops all its
 *   sockets at once, and clients on one fixed schedule all reconnect at
 *   the same moments.
 * @internal
 */
export function reconnectDefaults(): {
  connectionTimeout: number;
  minReconnectionDelay: number;
} {
  return {
    connectionTimeout: 15_000,
    minReconnectionDelay: 1000 + Math.floor(Math.random() * 4000)
  };
}

/**
 * The caller's timing options, with the defaults for any it left out or
 * passed as `undefined` (PartySocket would read `undefined` as its own
 * defaults).
 * @internal
 */
export function reconnectTimingFor(
  options: { connectionTimeout?: number; minReconnectionDelay?: number },
  defaults: { connectionTimeout: number; minReconnectionDelay: number }
): { connectionTimeout: number; minReconnectionDelay: number } {
  return {
    connectionTimeout: options.connectionTimeout ?? defaults.connectionTimeout,
    minReconnectionDelay:
      options.minReconnectionDelay ?? defaults.minReconnectionDelay
  };
}

/**
 * PartySocket's first retry delay: the minimum, capped by the maximum
 * (10 s when not set).
 * @internal
 */
export function firstRetryDelay(
  minReconnectionDelay: number,
  maxReconnectionDelay: number | undefined
): number {
  return Math.min(minReconnectionDelay, maxReconnectionDelay ?? 10_000);
}

/**
 * Whether a close came from this side on purpose (`close()`, `reconnect()`),
 * as opposed to a drop. PartySocket reports a handshake timeout as a close
 * with code 1000 and reason `"timeout"`, which is a drop. In browsers its
 * own close events reach listeners re-wrapped: `code` is `"close"` and
 * `reason` is the original event, so that one is read instead.
 * @internal
 */
export function isLocalClose(event: CloseEvent): boolean {
  const reason: unknown = event.reason;
  const original =
    typeof event.code !== "number" &&
    typeof reason === "object" &&
    reason !== null
      ? (reason as { code?: unknown; reason?: unknown })
      : { code: event.code, reason };
  return original.code === 1000 && original.reason !== "timeout";
}
