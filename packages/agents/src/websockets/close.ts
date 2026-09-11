/**
 * Reserved close codes the runtime synthesizes when there was no real
 * Close frame from the peer (1005 NoStatusReceived, 1006 AbnormalClosure,
 * 1015 TLSHandshake). They cannot appear in an outgoing Close frame, and
 * there is no peer left to receive a reciprocation.
 */
function isReservedCloseCode(code: number): boolean {
  return code === 1005 || code === 1006 || code === 1015;
}

/**
 * Reciprocate a peer-initiated Close frame to complete the handshake, as
 * the Hibernation API contract requires. Best-effort: swallows errors
 * from already-closed sockets or invalid codes/reasons, and skips
 * reciprocation entirely for reserved codes (dead transport).
 */
export function reciprocateClose(
  ws: WebSocket,
  code: number,
  reason: string
): void {
  if (isReservedCloseCode(code)) return;
  try {
    ws.close(code, reason);
  } catch {
    // Already closed, oversize reason, or another unrecoverable
    // invariant — the handshake is either done or out of our control.
  }
}
