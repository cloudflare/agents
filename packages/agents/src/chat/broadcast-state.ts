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
      /** Required when continuation=true so the accumulator can pick up existing parts. */
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
        let messageId = event.messageId;
        let existingParts: UIMessage["parts"] | undefined;
        let existingMetadata: Record<string, unknown> | undefined;

        if (event.continuation && event.currentMessages) {
          for (let i = event.currentMessages.length - 1; i >= 0; i--) {
            if (event.currentMessages[i].role === "assistant") {
              messageId = event.currentMessages[i].id;
              existingParts = [...event.currentMessages[i].parts];
              if (event.currentMessages[i].metadata != null) {
                existingMetadata = {
                  ...(event.currentMessages[i].metadata as Record<
                    string,
                    unknown
                  >)
                };
              }
              break;
            }
          }
        }

        accumulator = new StreamAccumulator({
          messageId,
          continuation: event.continuation,
          existingParts,
          existingMetadata
        });
      } else {
        accumulator = state.accumulator;
      }

      if (event.chunkData) {
        accumulator.applyChunk(event.chunkData as StreamChunkData);
      }

      let messagesUpdate: ((prev: UIMessage[]) => UIMessage[]) | undefined;

      if (event.done) {
        messagesUpdate = (prev) => accumulator.mergeInto(prev);
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
