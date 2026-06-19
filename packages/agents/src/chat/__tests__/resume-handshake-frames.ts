/**
 * Golden resume-handshake frames (rfc-chat-recovery-foundation, Tier-2).
 *
 * The byte-identical gate for extracting the shared resume-handshake module
 * (T2-2). The server-side REQUEST/ACK handlers in `@cloudflare/ai-chat` and
 * `@cloudflare/think` are byte-parallel: they emit the SAME outbound frame
 * shapes, differing only in the idle-connect payload, the outbound
 * use-chat-response constant, and the send/persist callbacks. These frozen
 * builders capture every outbound shape each branch emits, so the extracted
 * shared module must reproduce them exactly.
 *
 * Captured verbatim from the current handlers (pre-extraction):
 *  - ai-chat: `onMessage` `stream-resume-request` / `stream-resume-ack`
 *    (`index.ts` ~1062-1151), `_notifyStreamResuming` (~1341),
 *    `_replayTerminalOnResume` / `_replayTerminalOnAck` (~3896-3947).
 *  - think: `_handleStreamResumeRequest` / `_handleStreamResumeAck`
 *    (`think.ts` ~7470-7541), `_notifyStreamResuming` (~11176),
 *    `_replayTerminalOn*` (~11068-11114).
 *
 * Treat these builders as FROZEN. They model the exact bytes today's clients
 * parse; the T2-2 extraction asserts its shared module emits frames that
 * `toEqual` these, and any intended wire change must be a deliberate edit here
 * (paired with a client + changeset).
 */

import { CHAT_MESSAGE_TYPES } from "../protocol";

/**
 * Server -> client `STREAM_RESUMING` notify: there is a resumable stream (or a
 * pending terminal to replay, #1645) for `requestId`; the client should ACK to
 * receive the replay. Emitted by `_notifyStreamResuming` and
 * `_replayTerminalOnResume`.
 *
 * Load-bearing (#1733): a single connection can legitimately receive this twice
 * for one request — proactively from idle-connect AND in response to its
 * explicit `STREAM_RESUME_REQUEST`. The server must NOT dedupe; the client
 * dedupes its ACK. Both sends are byte-identical to this frame.
 */
export function streamResumingFrame(requestId: string) {
  return {
    type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
    id: requestId
  };
}

/**
 * Server -> client `STREAM_RESUME_NONE`: nothing to resume — no active stream
 * (and no pending continuation / terminal), or a DIFFERENT connection owns the
 * active continuation. Carries no `id`. Emitted by both REQUEST `else` branches.
 */
export function streamResumeNoneFrame() {
  return {
    type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE
  };
}

/**
 * Server -> client terminal replay-done frame: the ACK fallback when no live or
 * completed chunks remain to replay, closing the resumed stream cleanly.
 * `replay: true`, never `error`. `responseType` is the host's use-chat-response
 * constant (identical string for both hosts today).
 */
export function replayDoneFrame(
  requestId: string,
  responseType: string = CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
) {
  return {
    body: "",
    done: true,
    id: requestId,
    type: responseType,
    replay: true
  };
}

/**
 * Server -> client terminal error frame delivered on the resumed stream the
 * client just ACKed (#1645/#1575): the only path that surfaces as
 * `useChat.error`. `error: true`, `done: true`, and — unlike the replay-done
 * frame — NO `replay` flag (it mirrors a live terminal exactly). Emitted by
 * `_replayTerminalOnAck`.
 */
export function terminalErrorFrame(
  requestId: string,
  body: string,
  responseType: string = CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE
) {
  return {
    body,
    done: true,
    error: true,
    id: requestId,
    type: responseType
  };
}

/**
 * Server -> client "recovering…" progress hint (#1620). `recovering: true`,
 * with `id` only when the recovering record carries a request id. Emitted by
 * `buildChatRecoveringFrame` and, for `@cloudflare/think`, replayed on connect.
 */
export function recoveringFrame(
  requestId: string | undefined,
  messageType: string = CHAT_MESSAGE_TYPES.CHAT_RECOVERING
) {
  return {
    type: messageType,
    recovering: true,
    ...(requestId ? { id: requestId } : {})
  };
}

/**
 * Load-bearing handshake invariants the shared module must preserve — asserted
 * structurally in `resume-handshake-frames.test.ts` and called out so the T2-2
 * extraction can't silently regress them.
 */
export const HANDSHAKE_INVARIANTS = {
  /**
   * #1733: `STREAM_RESUMING` is sent on BOTH the proactive idle-connect notify
   * and the explicit `STREAM_RESUME_REQUEST` response. The server never dedupes
   * (an explicit request always deserves a reply, else `reconnectToStream`
   * hangs to its timeout); the client dedupes its ACK so the buffer isn't
   * replayed twice.
   */
  resumingSentOnBothNotifyAndRequest: true,
  /**
   * #1645: terminal frames are EXCLUDED from the idle-connect payload and
   * delivered only through the handshake — `STREAM_RESUMING` on the resume
   * request, then the terminal error frame once the client ACKs.
   */
  terminalExcludedFromIdleConnectDeliveredViaHandshake: true,
  /**
   * Idle-connect payload is the only documented divergence between hosts:
   * `@cloudflare/ai-chat` sends recovering-only; `@cloudflare/think` sends
   * transcript + recovering (`_buildIdleConnectMessages`).
   */
  idleConnectPayloadDiverges: {
    aiChat: "recovering-only",
    think: "transcript + recovering"
  }
} as const;
