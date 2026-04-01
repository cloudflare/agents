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
import type { ClientToolSchema } from "./client-tools";

const MSG_STREAM_RESUME_NONE = CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE;

/**
 * Minimal connection interface for sending WebSocket messages.
 * Matches the Connection type from agents without importing it.
 * Uses a permissive send signature so Connection (which extends
 * WebSocket with its own send overload) is structurally assignable.
 */
export interface ContinuationConnection {
  readonly id: string;
  send(message: string): void;
}

export interface ContinuationPending {
  connection: ContinuationConnection;
  connectionId: string;
  requestId: string;
  clientTools?: ClientToolSchema[];
  body?: Record<string, unknown>;
  errorPrefix: string | null;
  prerequisite: Promise<boolean> | null;
  pastCoalesce: boolean;
}

export interface ContinuationDeferred {
  connection: ContinuationConnection;
  connectionId: string;
  clientTools?: ClientToolSchema[];
  body?: Record<string, unknown>;
  errorPrefix: string;
  prerequisite: Promise<boolean> | null;
}

export class ContinuationState {
  pending: ContinuationPending | null = null;
  deferred: ContinuationDeferred | null = null;
  activeRequestId: string | null = null;
  activeConnectionId: string | null = null;
  awaitingConnections: Map<string, ContinuationConnection> = new Map();

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
   * Send STREAM_RESUME_NONE to all connections waiting for a
   * continuation stream to start, then clear the map.
   */
  sendResumeNone(): void {
    const msg = JSON.stringify({ type: MSG_STREAM_RESUME_NONE });
    for (const connection of this.awaitingConnections.values()) {
      connection.send(msg);
    }
    this.awaitingConnections.clear();
  }

  /**
   * Flush awaiting connections by notifying each one via the provided
   * callback (typically sends STREAM_RESUMING), then clear.
   */
  flushAwaitingConnections(
    notify: (conn: ContinuationConnection) => void
  ): void {
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
  ): ContinuationPending | null {
    if (this.pending || !this.deferred) return null;

    const d = this.deferred;
    this.deferred = null;
    this.activeRequestId = null;
    this.activeConnectionId = null;

    this.pending = {
      connection: d.connection,
      connectionId: d.connectionId,
      requestId: generateRequestId(),
      clientTools: d.clientTools,
      body: d.body,
      errorPrefix: d.errorPrefix,
      prerequisite: d.prerequisite,
      pastCoalesce: false
    };

    this.awaitingConnections.set(d.connectionId, d.connection);
    return this.pending;
  }
}
