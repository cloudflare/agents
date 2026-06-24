/**
 * PreStreamTurns — tracks accepted chat turns that have not yet started a
 * resumable stream, and the connections parked waiting for one.
 *
 * The resume handshake can resume an ACTIVE stream (chunks buffering) and can
 * replay a TERMINAL outcome, but a normal turn spends a window between "request
 * accepted" and "first chunk produced" in neither state: it is queued, waiting
 * on `waitForMcpConnections`, debouncing, or simply running async setup inside
 * `onChatMessage` before a stream object exists. A client that reconnects or
 * re-mounts in that window used to get `cf_agent_stream_resume_none` and give
 * up, so the turn the server went on to complete normally never drove the
 * client's AI-SDK `status` (issue #1784).
 *
 * This container lets a host represent that window as resumable: the handshake
 * parks the reconnecting connection here (and tells it to keep waiting), and the
 * host flushes the parked connections into the normal `STREAM_RESUMING` path the
 * moment a stream actually starts — or releases them with `resume_none` if the
 * turn settles without ever streaming.
 *
 * Concurrency-safe under queued turns via an accepted-request set: parked
 * connections are only released with `resume_none` once EVERY accepted turn has
 * settled with no active stream, so a client parked during the gap between one
 * turn finishing and the next starting still resumes onto the next stream.
 *
 * Pure data + send-through-callback, mirroring {@link ContinuationState}: the
 * host owns the actual frame sends and the stream-start / turn-settle wiring.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import { sendIfOpen, type ChatConnection } from "./connection";
import { CHAT_MESSAGE_TYPES } from "./protocol";

const MSG_STREAM_PENDING = CHAT_MESSAGE_TYPES.STREAM_PENDING;
const MSG_STREAM_RESUME_NONE = CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE;

export class PreStreamTurns<
  TConnection extends ChatConnection = ChatConnection
> {
  /**
   * Accepted-but-not-yet-streamed request ids. A turn enters on `begin()` and
   * leaves on `settle()`; the set being non-empty means "pre-stream work is in
   * flight", which gates parking and the eventual `resume_none` release.
   */
  private readonly _accepted = new Set<string>();

  /** Connections parked waiting for a stream to start. */
  readonly awaitingConnections = new Map<string, TConnection>();

  /** The most recently accepted pre-stream request id (for the keep-waiting frame). */
  private _latestRequestId: string | null = null;

  /** Mark a freshly-accepted turn as in flight (pre-stream). */
  begin(requestId: string): void {
    this._accepted.add(requestId);
    this._latestRequestId = requestId;
  }

  /**
   * Mark an accepted turn as settled. Returns `true` when no accepted turn
   * remains in flight (the caller should release parked connections if no
   * stream is active).
   */
  settle(requestId: string): boolean {
    this._accepted.delete(requestId);
    if (this._accepted.size === 0) {
      this._latestRequestId = null;
      return true;
    }
    return false;
  }

  /** Whether any accepted turn is still pre-stream. */
  hasInFlight(): boolean {
    return this._accepted.size > 0;
  }

  /** The request id to advertise in the keep-waiting frame, if known. */
  get latestRequestId(): string | null {
    return this._latestRequestId;
  }

  /**
   * Park a reconnecting connection and tell it to keep waiting (so its
   * transport does not resolve `reconnectToStream` early). No-op when nothing
   * is in flight. Parked connections are deliberately NOT added to the host's
   * `pendingResumeConnections` — they must keep receiving any live broadcast —
   * until the host flushes them through `notifyStreamResuming` on stream start.
   */
  park(connection: TConnection): boolean {
    if (!this.hasInFlight()) return false;
    this.awaitingConnections.set(connection.id, connection);
    sendIfOpen(
      connection,
      JSON.stringify({
        type: MSG_STREAM_PENDING,
        ...(this._latestRequestId ? { id: this._latestRequestId } : {})
      })
    );
    return true;
  }

  /** Drop a single connection (e.g. on socket close) without releasing others. */
  release(connectionId: string): void {
    this.awaitingConnections.delete(connectionId);
  }

  /**
   * A stream has started: hand every parked connection to `notify` (the host's
   * `notifyStreamResuming`, which sends `STREAM_RESUMING` and excludes the
   * connection from live broadcast until it ACKs), then clear the awaiting map.
   * The accepted set is untouched — the turn is still running.
   */
  flushOnStreamStart(notify: (connection: TConnection) => void): void {
    for (const connection of this.awaitingConnections.values()) {
      notify(connection);
    }
    this.awaitingConnections.clear();
  }

  /**
   * Release every parked connection with `STREAM_RESUME_NONE` (the turn settled
   * without ever starting a stream) and clear the awaiting map. Safe to call
   * when the map is empty (no-op), so the host can call it liberally from a
   * turn-settle path.
   */
  releaseAwaiting(): void {
    const msg = JSON.stringify({ type: MSG_STREAM_RESUME_NONE });
    for (const connection of this.awaitingConnections.values()) {
      sendIfOpen(connection, msg);
    }
    this.awaitingConnections.clear();
  }

  /** Drop all state (chat clear / destroy). Does not send any frames. */
  reset(): void {
    this._accepted.clear();
    this.awaitingConnections.clear();
    this._latestRequestId = null;
  }
}
