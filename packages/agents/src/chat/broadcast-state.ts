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

      if (state.status === "idle" || state.streamId !== event.streamId) {
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

      if (event.done || event.error) {
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
