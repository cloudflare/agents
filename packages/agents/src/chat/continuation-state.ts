/**
 * The auto-continuation slots (`ContinuationSlots`) and the types and pure
 * helpers the continuation lifecycle shares (`continuation-turn.ts`,
 * `ChatTurns`' barrier).
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
  /**
   * The messages whose tool results or approvals this continuation answers.
   * It runs only while one of them is still the last message
   * ({@link continuationTargetIsLatest}). Every continuation has at least
   * one: there is no continuation that runs whatever the transcript.
   */
  targetMessageIds: readonly string[];
}

/**
 * The continuation slots `ChatTurns` keeps: the continuation a tool answer
 * scheduled whose turn has not started (`pending`), the one whose turn
 * started and whose stream has not (`running`), the one whose stream runs
 * (`activeRequestId`), and the tabs waiting for a continuation's stream.
 *
 * An answer that arrives while a continuation runs schedules the next
 * pending continuation, whose turn waits behind the running one in the
 * lane: there is no deferred slot.
 */
export class ContinuationSlots<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  pending: ContinuationPending<TConnection> | null = null;
  running: ContinuationPending<TConnection> | null = null;
  activeRequestId: string | null = null;
  activeConnectionId: string | null = null;
  awaitingConnections: Map<string, TConnection> = new Map();

  /** Free the pending slot and forget the waiting tabs, sending nothing. */
  clearPending(): void {
    this.pending = null;
    this.awaitingConnections.clear();
  }

  clearAll(): void {
    this.clearPending();
    this.running = null;
    this.activeRequestId = null;
    this.activeConnectionId = null;
  }

  /** A tab left: forget it without cancelling the continuation it started. */
  releaseConnection(connectionId: string): void {
    this.awaitingConnections.delete(connectionId);
    if (this.pending?.connectionId === connectionId) {
      this.pending = { ...this.pending, connectionId: null };
    }
    if (this.running?.connectionId === connectionId) {
      this.running = { ...this.running, connectionId: null };
    }
    if (this.activeConnectionId === connectionId) {
      this.activeConnectionId = null;
    }
  }

  /** Tell every waiting tab there is no stream (`STREAM_RESUME_NONE`). */
  sendResumeNone(): void {
    const msg = JSON.stringify({ type: MSG_STREAM_RESUME_NONE });
    for (const connection of this.awaitingConnections.values()) {
      sendIfOpen(connection, msg);
    }
    this.awaitingConnections.clear();
  }

  /**
   * The pending continuation's tab waits on it. While another continuation
   * runs and its stream has not started, the tabs waiting are that one's,
   * so this waits until that one's stream starts or its turn ends.
   */
  awaitPending(): void {
    const pending = this.pending;
    if (!pending || pending.connectionId === null || this.running) return;
    this.awaitingConnections.set(pending.connectionId, pending.connection);
  }

  /** Hand every waiting tab to `notify` (`STREAM_RESUMING`), then forget them. */
  flushAwaitingConnections(notify: (conn: TConnection) => void): void {
    for (const connection of this.awaitingConnections.values()) {
      notify(connection);
    }
    this.awaitingConnections.clear();
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

/**
 * The window that batches adjacent client tool results and approvals into
 * one continuation barrier check (#1650), in milliseconds.
 */
export const CONTINUATION_COALESCE_MS = 50;

/**
 * The data a host supplies to schedule (or re-target) a pending/deferred
 * auto-continuation. The tools and body the continuation turn runs with are
 * not part of it: the turn reads the stored request context when it starts
 * (`ChatTurns.lastClientTools`), so there is one copy of them.
 */
export interface ContinuationSpec<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  connection: TConnection;
  errorPrefix: string;
  /**
   * The message the result or approval is stored in: the assistant message
   * whose tool part it settled. The continuation runs only while that
   * message is the latest.
   */
  targetMessageId: string;
}

/**
 * A {@link ContinuationSpec} before its target is known. The target comes
 * from applying the result ({@link ToolInteractionOutcome}).
 */
export type ContinuationSource<
  TConnection extends ContinuationConnection = ContinuationConnection
> = Omit<ContinuationSpec<TConnection>, "targetMessageId">;

/**
 * What applying a client tool result or approval did to its tool part:
 * settled it (in the message `messageId`), found it already settled, or
 * found no such part.
 */
export type ToolInteractionOutcome =
  | { status: "changed"; messageId: string }
  | { status: "unchanged" }
  | { status: "missing" };
