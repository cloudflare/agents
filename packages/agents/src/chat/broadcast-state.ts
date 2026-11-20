/**
 * Broadcast stream state machine.
 *
 * Manages the lifecycle of a StreamAccumulator for broadcast/resume
 * streams — the path where this client is *observing* a stream owned
 * by another tab or resumed after reconnect, rather than the transport-
 * owned path that feeds directly into useChat.
 *
 * The transition function is pure (no React, no WebSocket, no side
 * effects). Callers dispatch events and apply the returned state +
 * messagesUpdate. Side effects (sending ACKs, calling onData) stay
 * in the caller.
 */

import type { UIMessage } from "ai";
import { StreamAccumulator } from "./stream-accumulator";
import type { StreamChunkData } from "./message-builder";
import { dropEmptyReply } from "./reply-empty";

// ── State ──────────────────────────────────────────────────────────

export type BroadcastStreamState =
  | { status: "idle" }
  | {
      status: "observing";
      streamId: string;
      accumulator: StreamAccumulator;
    };

// ── Events ─────────────────────────────────────────────────────────

export type BroadcastStreamEvent =
  | {
      type: "response";
      streamId: string;
      /** Fallback message ID for a new accumulator (ignored if one exists for this stream). */
      messageId: string;
      chunkData?: unknown;
      done?: boolean;
      error?: boolean;
      replay?: boolean;
      replayComplete?: boolean;
      continuation?: boolean;
      /**
       * For a continuation: the message the server stores it in (`messageId`
       * on the frame). Absent means the last assistant message.
       */
      continuationMessageId?: string;
      /** @deprecated Continuations now seed from current messages in `messagesUpdate`. */
      currentMessages?: UIMessage[];
    }
  | {
      type: "resume-fallback";
      streamId: string;
      messageId: string;
    }
  | { type: "clear" };

// ── Result ─────────────────────────────────────────────────────────

export interface TransitionResult {
  state: BroadcastStreamState;
  messagesUpdate?: (prev: UIMessage[]) => UIMessage[];
  isStreaming: boolean;
}

// ── Snapshot reconciliation ────────────────────────────────────────

function textOf(parts: UIMessage["parts"]): string {
  let text = "";
  for (const part of parts) {
    if (part.type === "text") text += part.text;
  }
  return text;
}

/**
 * Whether `messages` already holds a copy of the observed message whose text
 * the accumulator does not extend. A healthy live accumulator is always the
 * stored copy plus more; one that diverges holds interleaved or duplicated
 * chunks (#2166), so the stored copy must win or the corruption never heals.
 */
export function observedDivergesFrom(
  accumulator: StreamAccumulator,
  messages: UIMessage[]
): boolean {
  // A continuation that has not adopted its message yet holds only its own
  // chunks: there is nothing to compare until `mergeInto` seeds it.
  if (accumulator.awaitsSeed) return false;
  const existing = messages.find((m) => m.id === accumulator.messageId);
  if (!existing) return false;
  return !textOf(accumulator.parts).startsWith(textOf(existing.parts));
}

// ── Transition ─────────────────────────────────────────────────────

export function transition(
  state: BroadcastStreamState,
  event: BroadcastStreamEvent
): TransitionResult {
  switch (event.type) {
    case "clear":
      return { state: { status: "idle" }, isStreaming: false };

    case "resume-fallback": {
      const accumulator = new StreamAccumulator({
        messageId: event.messageId
      });
      return {
        state: {
          status: "observing",
          streamId: event.streamId,
          accumulator
        },
        isStreaming: true
      };
    }

    case "response": {
      let accumulator: StreamAccumulator;

      // A replayed `start` chunk means the server is re-sending the stream
      // buffer from chunk 0 (resume replay). Re-initialize the accumulator
      // instead of appending into an existing one: replaying into an
      // accumulator that already holds this stream's parts would duplicate
      // them (a second `text-start` unconditionally opens a second text
      // part — #1733). Re-initializing makes replay idempotent under any
      // number of replays, including a second replay triggered by a
      // duplicate STREAM_RESUMING → ACK cycle or a reconnect.
      const isReplayedStart =
        event.replay === true &&
        (event.chunkData as { type?: string } | null | undefined)?.type ===
          "start";

      if (
        state.status === "idle" ||
        state.streamId !== event.streamId ||
        isReplayedStart
      ) {
        const named =
          event.continuation === true &&
          event.continuationMessageId !== undefined;
        accumulator = new StreamAccumulator({
          messageId: named
            ? (event.continuationMessageId as string)
            : event.messageId,
          continuation: event.continuation,
          continuationMessageNamed: named
        });
      } else {
        accumulator = state.accumulator;
      }

      if (event.chunkData) {
        accumulator.applyChunk(event.chunkData as StreamChunkData);
      }

      let messagesUpdate: ((prev: UIMessage[]) => UIMessage[]) | undefined;

      const mergeUnlessDiverged = (prev: UIMessage[]) =>
        observedDivergesFrom(accumulator, prev)
          ? prev
          : accumulator.mergeInto(prev);

      if (event.done) {
        // A stream that ended with nothing in it (stopped before its first
        // content) leaves no empty bubble behind: the server stores none.
        return {
          state: { status: "idle" },
          messagesUpdate: (prev) =>
            dropEmptyReply(mergeUnlessDiverged(prev), accumulator.messageId),
          isStreaming: false
        };
      }

      if (event.chunkData && !event.replay) {
        messagesUpdate = mergeUnlessDiverged;
      } else if (event.replayComplete) {
        messagesUpdate = (prev) => accumulator.mergeInto(prev);
      }

      return {
        state: {
          status: "observing",
          streamId: event.streamId,
          accumulator
        },
        messagesUpdate,
        isStreaming: true
      };
    }
  }
}
