/**
 * Shared resume-handshake driver (rfc-chat-recovery-foundation, Tier-2).
 *
 * The server side of the WebSocket stream-resume protocol — the byte-parallel
 * block `@cloudflare/ai-chat` and `@cloudflare/think` previously hand-maintained
 * in lockstep, now shared here:
 * the proactive `STREAM_RESUMING` notify, the `STREAM_RESUME_REQUEST` decision
 * tree, the `STREAM_RESUME_ACK` decision tree, and the terminal-replay path
 * (#1645). The two hosts diverge only in the idle-connect payload (kept
 * host-owned, NOT here) and the use-chat-response message-type constant (a
 * {@link ResumeHandshakeHost} field).
 *
 * Frame shapes are frozen by the golden fixture in
 * `__tests__/resume-handshake-frames.ts`; this driver must keep emitting exactly
 * those bytes.
 *
 * `@internal` — sibling-package support, not a public API. See
 * `design/rfc-chat-recovery-foundation.md`.
 */

import type { Connection } from "agents";
import { sendIfOpen } from "./connection";
import { CHAT_MESSAGE_TYPES } from "./protocol";
import type { ContinuationState } from "./continuation-state";
import type { PreStreamTurns } from "./pre-stream-turns";
import type { ResumableStream } from "./resumable-stream";

/** A pending terminal outcome captured before connect (#1645). */
export interface PendingChatTerminal {
  requestId: string;
  body: string;
}

/**
 * The host-owned surface the resume handshake threads. `pendingResumeConnections`
 * (and the continuation `awaitingConnections` map) stay host-owned — they are
 * also touched by the streaming loop, which is NOT part of this extraction — so
 * the driver only reads/mutates them through this seam rather than owning them.
 */
export interface ResumeHandshakeHost {
  /** The host's use-chat-response message-type constant (wire string). */
  readonly responseMessageType: string;
  readonly resumableStream: ResumableStream;
  readonly continuation: ContinuationState<Connection>;
  /**
   * Accepted-but-not-yet-streamed turns (#1784). Optional: experimental
   * recovery adapters that don't track a pre-stream window omit it and keep the
   * legacy `resume_none` behavior. When present, the handshake parks a
   * reconnecting client here (sending a keep-waiting `STREAM_PENDING`) instead
   * of telling it there is nothing to resume.
   */
  readonly preStream?: PreStreamTurns<Connection>;
  /**
   * Connections notified of a resumable stream, excluded from live broadcast
   * until they ACK. Host-owned (shared with the streaming loop).
   */
  readonly pendingResumeConnections: Set<string>;
  /** Read the pending terminal outcome (#1645), or `null` when none survives. */
  pendingChatTerminal(): Promise<PendingChatTerminal | null>;
  /** Materialize an orphaned stream's partial into a persisted assistant message. */
  persistOrphanedStream(streamId: string): Promise<void>;
  /**
   * Whether the connection that owns the active continuation stream is still
   * connected. Optional: when omitted the handshake assumes it is (legacy
   * behavior). Hosts wire their live connection registry so a continuation
   * stream whose owner vanished on an abrupt (1006) reconnect can still be
   * resumed by the replacement connection (#1784).
   */
  isConnectionPresent?(connectionId: string): boolean;
}

/**
 * Drives the server side of the stream-resume protocol over a
 * {@link ResumeHandshakeHost}. Construct once per agent (the host wires its
 * `ResumableStream` / `ContinuationState` / pending set in) and call the three
 * public methods from the host's existing onConnect / onMessage wiring, so
 * handler registration timing stays host-owned.
 */
export class ResumeHandshake {
  constructor(private readonly host: ResumeHandshakeHost) {}

  /**
   * Notify a connection that an active stream can be resumed; it should reply
   * with `STREAM_RESUME_ACK` to receive the replay.
   *
   * A connection can legitimately be notified more than once for the same
   * request — proactively from onConnect AND in response to its explicit
   * `STREAM_RESUME_REQUEST` (#1733). This is intentional and must NOT be deduped
   * here: an explicit request always deserves a response (else the client's
   * `reconnectToStream` hangs to its timeout with no replay), and the proactive
   * notify is required for clients that never send a request. The notify is one
   * tiny frame; the client dedupes its ACK so the buffer is not replayed twice.
   */
  notifyStreamResuming(connection: Connection): void {
    const { resumableStream, pendingResumeConnections } = this.host;
    if (!resumableStream.hasActiveStream()) return;
    const sent = sendIfOpen(
      connection,
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
        id: resumableStream.activeRequestId
      })
    );
    if (sent) {
      // Add to pending set — excluded from live broadcasts until they ACK to
      // receive the full stream replay.
      pendingResumeConnections.add(connection.id);
    }
  }

  /**
   * Handle a client `STREAM_RESUME_REQUEST`. The client sends this after its
   * message handler is registered, avoiding the race where a proactive
   * `STREAM_RESUMING` from onConnect arrives before the handler is ready.
   */
  async handleResumeRequest(connection: Connection): Promise<void> {
    const { resumableStream, continuation, preStream } = this.host;
    if (resumableStream.hasActiveStream()) {
      if (
        continuation.activeRequestId === resumableStream.activeRequestId &&
        continuation.activeConnectionId !== null &&
        continuation.activeConnectionId !== connection.id &&
        this._ownerStillPresent(continuation.activeConnectionId)
      ) {
        sendIfOpen(
          connection,
          JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE })
        );
      } else {
        this.notifyStreamResuming(connection);
      }
    } else if (
      continuation.pending !== null &&
      (continuation.pending.connectionId === null ||
        continuation.pending.connectionId === connection.id)
    ) {
      // A continuation turn is accepted but its stream has not started yet.
      // Park the connection AND tell it to keep waiting (#1784) so its resume
      // probe does not time out before the continuation stream begins; the host
      // flushes `awaitingConnections` into `STREAM_RESUMING` on stream start.
      continuation.awaitingConnections.set(connection.id, connection);
      this._sendStreamPending(connection, continuation.pending.requestId);
    } else if (await this._replayTerminalOnResume(connection)) {
      // A turn terminalized while no client was connected (#1645): drive the
      // resume handshake so the terminal error frame can be delivered on the
      // resumed stream (the only path that surfaces as an error on the client)
      // once this connection ACKs — see `_replayTerminalOnAck`.
    } else if (preStream?.park(connection)) {
      // A normal turn is accepted but its resumable stream has not started yet
      // (#1784). `park` enrolled the connection and sent `STREAM_PENDING`; the
      // host flushes it into `STREAM_RESUMING` on stream start, or releases it
      // with `STREAM_RESUME_NONE` if the turn settles without streaming.
    } else {
      sendIfOpen(
        connection,
        JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE })
      );
    }
  }

  /** Send a keep-waiting `STREAM_PENDING` frame (#1784). */
  private _sendStreamPending(connection: Connection, requestId?: string): void {
    sendIfOpen(
      connection,
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_PENDING,
        ...(requestId ? { id: requestId } : {})
      })
    );
  }

  /** Whether the active continuation's owner connection is still present. */
  private _ownerStillPresent(connectionId: string): boolean {
    return this.host.isConnectionPresent
      ? this.host.isConnectionPresent(connectionId)
      : true;
  }

  /** Handle a client `STREAM_RESUME_ACK` for `requestId`. */
  async handleResumeAck(
    connection: Connection,
    requestId: string
  ): Promise<void> {
    const { resumableStream, pendingResumeConnections, responseMessageType } =
      this.host;
    pendingResumeConnections.delete(connection.id);

    if (
      resumableStream.hasActiveStream() &&
      resumableStream.activeRequestId === requestId
    ) {
      const orphanedStreamId = resumableStream.replayChunks(
        connection,
        resumableStream.activeRequestId
      );
      // If the stream was orphaned (restored from SQLite after hibernation with
      // no live reader), reconstruct the partial assistant message from stored
      // chunks and persist it so it survives further page refreshes.
      if (orphanedStreamId) {
        await this.host.persistOrphanedStream(orphanedStreamId);
      }
    } else if (resumableStream.hasActiveStream()) {
      // Ignore ACKs for a different active stream request id.
    } else if (await this._replayTerminalOnAck(connection, requestId)) {
      // Delivered the pending terminal error frame on the resumed stream the
      // client just ACKed (#1645).
    } else if (
      !resumableStream.replayCompletedChunksByRequestId(connection, requestId)
    ) {
      sendIfOpen(
        connection,
        JSON.stringify({
          body: "",
          done: true,
          id: requestId,
          type: responseMessageType,
          replay: true
        })
      );
    }
  }

  /**
   * Replay a pending terminal outcome (#1645) over the resume handshake so a
   * reconnecting client surfaces it exactly like a live exhaustion. The bare
   * terminal frame is dropped by the client unless it arrives on a resumed
   * stream — the only path that reaches the transport's stream reader and
   * becomes `useChat.error` — so we drive `STREAM_RESUMING` here and deliver the
   * error frame once the client ACKs (see {@link _replayTerminalOnAck}). Returns
   * `true` if a terminal was pending (and `STREAM_RESUMING` was sent).
   */
  private async _replayTerminalOnResume(
    connection: Connection
  ): Promise<boolean> {
    const pending = await this.host.pendingChatTerminal();
    if (!pending) return false;
    sendIfOpen(
      connection,
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
        id: pending.requestId
      })
    );
    return true;
  }

  /**
   * Deliver the pending terminal error frame on the resumed stream the client
   * ACKed (#1645). The record is retained (not cleared) so concurrent reconnects
   * (e.g. multiple tabs) each learn the outcome; it is cleared when a later turn
   * supersedes it.
   */
  private async _replayTerminalOnAck(
    connection: Connection,
    requestId: string
  ): Promise<boolean> {
    const { resumableStream, responseMessageType } = this.host;
    const pending = await this.host.pendingChatTerminal();
    if (!pending || pending.requestId !== requestId) return false;
    // Replay any partial content the errored stream produced before the error,
    // so the reconnecting client observes the same sequence a live client did —
    // content chunks, then the terminal error (#1575). If the connection drops
    // mid-replay, skip the terminal frame; the record is retained, so the next
    // reconnect retries the whole sequence.
    if (
      !resumableStream.replayErroredChunksByRequestId(
        connection,
        pending.requestId
      )
    ) {
      return true;
    }
    sendIfOpen(
      connection,
      JSON.stringify({
        body: pending.body,
        done: true,
        error: true,
        id: pending.requestId,
        type: responseMessageType
      })
    );
    return true;
  }
}
