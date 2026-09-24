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
        accumulator = new StreamAccumulator({
          messageId: event.messageId,
          continuation: event.continuation
        });
      } else {
        accumulator = state.accumulator;
      }

      if (event.chunkData) {
        accumulator.applyChunk(event.chunkData as StreamChunkData);
      }

      let messagesUpdate: ((prev: UIMessage[]) => UIMessage[]) | undefined;

      if (event.done) {
        messagesUpdate = (prev) =>
          observedDivergesFrom(accumulator, prev)
            ? prev
            : accumulator.mergeInto(prev);
        return {
          state: { status: "idle" },
          messagesUpdate,
          isStreaming: false
        };
      }

      if (event.chunkData && !event.replay) {
        messagesUpdate = (prev) => accumulator.mergeInto(prev);
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
