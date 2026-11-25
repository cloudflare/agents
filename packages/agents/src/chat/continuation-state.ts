/**
 * ContinuationState — shared state container for auto-continuation lifecycle.
 *
 * Tracks pending, deferred, and active continuation state for the
 * tool-result → auto-continue flow. Both AIChatAgent and Think use this
 * to manage which connection/tools/body a continuation turn should use
 * and to coordinate with clients requesting stream resume.
 *
 * The scheduling algorithm (prerequisite chaining, debounce, TurnQueue
 * enrollment) stays in the host — this class only manages the data.
 */

import { CHAT_MESSAGE_TYPES } from "./protocol";
import { sendIfOpen, type ChatConnection } from "./connection";

const MSG_STREAM_RESUME_NONE = CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE;

/**
 * Minimal connection interface for sending WebSocket messages. Alias of the
 * shared {@link ChatConnection} — kept as a named export for back-compat with
 * existing `ContinuationConnection` consumers.
 */
export type ContinuationConnection = ChatConnection;

export interface ContinuationPending<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  connection: TConnection;
  connectionId: string | null;
  requestId: string;
  errorPrefix: string | null;
  prerequisite: Promise<boolean> | null;
  pastCoalesce: boolean;
  /**
   * The messages whose tool results or approvals this continuation answers.
   * It runs only while one of them is still the last message
   * ({@link continuationTargetIsLatest}). Every continuation has at least
   * one: there is no continuation that runs whatever the transcript.
   */
  targetMessageIds: readonly string[];
}

export interface ContinuationDeferred<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  connection: TConnection;
  connectionId: string | null;
  errorPrefix: string;
  prerequisite: Promise<boolean> | null;
  targetMessageIds: readonly string[];
}

export class ContinuationState<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  pending: ContinuationPending<TConnection> | null = null;
  deferred: ContinuationDeferred<TConnection> | null = null;
  activeRequestId: string | null = null;
  activeConnectionId: string | null = null;
  awaitingConnections: Map<string, TConnection> = new Map();

  /** Clear pending state and awaiting connections (without sending RESUME_NONE). */
  clearPending(): void {
    this.pending = null;
    this.awaitingConnections.clear();
  }

  clearDeferred(): void {
    this.deferred = null;
  }

  clearAll(): void {
    this.clearPending();
    this.clearDeferred();
    this.activeRequestId = null;
    this.activeConnectionId = null;
  }

  /**
   * Mark a connection as no longer available without canceling the
   * continuation it initiated.
   */
  releaseConnection(connectionId: string): void {
    this.awaitingConnections.delete(connectionId);
    if (this.pending?.connectionId === connectionId) {
      this.pending = { ...this.pending, connectionId: null };
    }
    if (this.deferred?.connectionId === connectionId) {
      this.deferred = { ...this.deferred, connectionId: null };
    }
    if (this.activeConnectionId === connectionId) {
      this.activeConnectionId = null;
    }
  }

  /**
   * Send STREAM_RESUME_NONE to all connections waiting for a
   * continuation stream to start, then clear the map.
   */
  sendResumeNone(): void {
    const msg = JSON.stringify({ type: MSG_STREAM_RESUME_NONE });
    for (const connection of this.awaitingConnections.values()) {
      sendIfOpen(connection, msg);
    }
    this.awaitingConnections.clear();
  }

  /**
   * Flush awaiting connections by notifying each one via the provided
   * callback (typically sends STREAM_RESUMING), then clear.
   */
  flushAwaitingConnections(notify: (conn: TConnection) => void): void {
    for (const connection of this.awaitingConnections.values()) {
      notify(connection);
    }
    this.awaitingConnections.clear();
  }

  /**
   * Transition pending → active. Called when the continuation stream
   * actually starts. Moves request/connection IDs to active slots,
   * clears pending fields.
   */
  activatePending(): void {
    if (!this.pending) return;
    this.activeRequestId = this.pending.requestId;
    this.activeConnectionId = this.pending.connectionId;
    this.pending = null;
  }

  /**
   * Transition deferred → pending. Called when a continuation turn
   * completes and there's a deferred follow-up waiting.
   *
   * Returns the new pending state (so the host can enqueue the turn),
   * or null if there was nothing deferred.
   */
  activateDeferred(
    generateRequestId: () => string
  ): ContinuationPending<TConnection> | null {
    if (this.pending || !this.deferred) return null;

    const d = this.deferred;
    this.deferred = null;
    this.activeRequestId = null;
    this.activeConnectionId = null;

    this.pending = {
      connection: d.connection,
      connectionId: d.connectionId,
      requestId: generateRequestId(),
      errorPrefix: d.errorPrefix,
      prerequisite: d.prerequisite,
      pastCoalesce: false,
      targetMessageIds: d.targetMessageIds
    };

    if (d.connectionId !== null) {
      this.awaitingConnections.set(d.connectionId, d.connection);
    }
    return this.pending;
  }
}

/** Add `id` to a continuation's targets. */
export function addContinuationTarget(
  targets: readonly string[] | undefined,
  id: string
): readonly string[] {
  if (targets === undefined) return [id];
  return targets.includes(id) ? targets : [...targets, id];
}

/**
 * Whether a pending continuation still has something to answer: a message
 * whose tool result scheduled it is the last message.
 *
 * A later message of any kind moves the conversation on: a newer question,
 * a newer reply, and a message appended without a turn (a status note an
 * app stored with `persistMessages`, a detached run's milestone). Continuing
 * past one would make the model answer inside, or after, a message that did
 * not ask for it, and the request would end in that message, which some
 * providers reject. Mirrors pi's `continue()`, which settles a transcript
 * that already ends in an answer as `nothing_to_answer`. A regenerate or a
 * clear removes the message, which also ends the continuation.
 *
 * The tool result itself stays stored, and the next turn's model call
 * reads it.
 *
 * @param messages - The transcript.
 * @param pending - The pending continuation.
 */
export function continuationTargetIsLatest(
  messages: ReadonlyArray<{ id: string }>,
  pending: Pick<ContinuationPending, "targetMessageIds">
): boolean {
  const last = messages.at(-1)?.id;
  return last !== undefined && pending.targetMessageIds.includes(last);
}
