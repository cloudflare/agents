/**
 * `PiRecoveryCodec` — the pi half of the streaming-codec seam Phase 5 validates.
 *
 * The shared recovery engine reconstructs an interrupted turn's partial
 * assistant state by replaying a durable stream buffer through a codec. The AI
 * SDK adapter uses `applyChunkToParts` (`agents/chat/message-builder`) over AI
 * SDK SSE chunks; pi uses THIS over its OWN event vocabulary — the real
 * `@earendil-works/pi-agent-core` `AgentEvent` stream (`message_update` carrying
 * an `AssistantMessageEvent`). Both feed the engine the identical
 * `RecoveryPartial` shape (`{ text, parts }`), so the engine never sees the wire
 * vocabulary. That is the proof the codec — not the engine — owns the
 * chunk-shape differences.
 *
 * The reconstructed partial is not just inspected and discarded: `PiAgent`
 * preserves it (`persistOrphanedStream`) and the recovered turn CONTINUES from
 * it — the model regenerates only the remaining suffix, which merges onto the
 * survived prefix (`stream_continuation`, mirroring the AI SDK adapter and
 * Flue's `recoverInterruptedStream`). So `decodePartial` must surface both the
 * accumulated prefix text AND a clonable partial `AssistantMessage` to merge
 * the continuation onto.
 *
 * @internal Validation fixture, not a published package.
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ChatRecoveryCodec, RecoveryPartial } from "agents/chat";

/** The buffer-worthy subset of pi's `AgentEvent` stream (carries text progress). */
type BufferedPiEvent = Extract<
  AgentEvent,
  { type: "message_update" } | { type: "message_end" }
>;

/** A reconstructed pi partial: accumulated assistant text + the partial message. */
export interface PiPartial {
  text: string;
  message: AssistantMessage | null;
}

/** Render an assistant message's text blocks into plain text. */
export function renderAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export class PiRecoveryCodec implements ChatRecoveryCodec {
  /**
   * Decide whether a pi `AgentEvent` carries recoverable streaming progress and,
   * if so, serialize it into a `ResumableStream` chunk body. The buffer treats
   * each body as an opaque JSON OBJECT string (a top-level array is reserved for
   * its packed-segment encoding), and `AgentEvent`s serialize to objects.
   *
   * Only the assistant streaming events are buffered — `message_update` (the
   * incremental `text_delta` / `text_end`) and `message_end` (the authoritative
   * final message). Lifecycle/tool/turn events carry no partial-text progress
   * and are skipped, keeping the buffer to exactly what recovery replays.
   */
  encodeEvent(event: AgentEvent): string | null {
    if (event.type === "message_update" || event.type === "message_end") {
      return JSON.stringify(event);
    }
    return null;
  }

  /** Parse one stored chunk body back into a buffered pi event, or `null`. */
  decodeEvent(body: string): BufferedPiEvent | null {
    try {
      const parsed = JSON.parse(body) as AgentEvent;
      if (parsed.type === "message_update" || parsed.type === "message_end") {
        return parsed;
      }
    } catch {
      // Tolerate a torn final write — recovery still surfaces the prefix.
    }
    return null;
  }

  /**
   * Replay the stored chunk bodies (oldest-first) into a partial assistant
   * message. A `message_end` body (or a `text_end` / `done` inner event) is
   * authoritative — its message text replaces the accumulated deltas. Otherwise
   * text is accumulated from `text_delta` deltas. A decode failure (a crash can
   * tear the final body mid-write) stops replay, preserving the prefix.
   */
  decodePartial(bodies: string[]): PiPartial {
    let text = "";
    let message: AssistantMessage | null = null;

    for (const body of bodies) {
      const event = this.decodeEvent(body);
      if (!event) break;

      if (event.type === "message_end") {
        if (event.message.role === "assistant") {
          message = event.message;
          text = renderAssistantText(event.message);
        }
        continue;
      }

      // message_update: drive from the inner pi AssistantMessageEvent.
      const inner = event.assistantMessageEvent;
      if (event.message.role === "assistant") {
        message = event.message;
      }
      if (inner.type === "text_delta") {
        text += inner.delta;
      } else if (inner.type === "text_end") {
        text = renderAssistantText(inner.partial);
      } else if (inner.type === "done") {
        text = renderAssistantText(inner.message);
      }
    }

    return { text, message };
  }

  /**
   * Adapt the decoded pi partial to the engine's `RecoveryPartial`. Pi text
   * turns produce no tool parts, so `parts` is empty and `hasSettledToolResults`
   * is `false` — correct for a text-only turn, and the engine consumes only that
   * boolean (never a part shape), so pi stays vocabulary-agnostic too.
   */
  toRecoveryPartial(bodies: string[]): RecoveryPartial {
    const { text } = this.decodePartial(bodies);
    return { text, parts: [], hasSettledToolResults: false };
  }

  /**
   * Pi's progress MILESTONE: the authoritative final assistant message
   * (`message_end`). Pi is HTTP-only with no streaming no-progress window today,
   * so nothing consults this; it conforms to {@link ChatRecoveryCodec} and shows
   * the predicate is per-vocabulary (the codec, not the engine, owns "what counts
   * as progress"). Disjoint from {@link isStreamingContentChunk}.
   */
  isProgressChunk(type: string | undefined): boolean {
    return type === "message_end";
  }

  /**
   * Pi's mid-segment streaming content: the incremental `message_update` (inner
   * `text_delta`) events. Maps to the AI SDK codec's `text-delta` arm — credited
   * through the host throttle rather than as a milestone.
   */
  isStreamingContentChunk(type: string | undefined): boolean {
    return type === "message_update";
  }
}
