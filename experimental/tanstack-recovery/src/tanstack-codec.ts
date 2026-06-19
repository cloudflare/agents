/**
 * `TanStackRecoveryCodec` — the TanStack/AG-UI half of the streaming-codec seam.
 *
 * The shared recovery engine reconstructs an interrupted turn's partial assistant
 * state by replaying a durable stream buffer through a {@link ChatRecoveryCodec}.
 * The AI SDK adapter (`AISDKRecoveryCodec`) replays AI-SDK SSE chunks; pi replays
 * its own `AgentEvent` vocabulary; this one replays the AG-UI `StreamChunk`
 * vocabulary a TanStack AI client/provider speaks (`TEXT_MESSAGE_CONTENT` deltas,
 * `TOOL_CALL_*`, …). All three feed the engine the identical `RecoveryPartial`
 * shape (`{ text, parts }`), so the engine never sees the wire vocabulary — the
 * codec owns the chunk-shape differences. This is the second genericity axis the
 * pi fixture left untested: a foreign streaming chunk vocabulary, not pi's events
 * (rfc-chat-recovery-foundation, Phase 5 second harness).
 *
 * @internal Validation fixture, not a published package.
 */

import { EventType, type StreamChunk } from "@tanstack/ai/client";
import type {
  ChatRecoveryCodec,
  MessagePart,
  RecoveryPartial
} from "agents/chat";

/** Parse one stored chunk body back into an AG-UI `StreamChunk`, or `null`. */
function decodeChunk(body: string): StreamChunk | null {
  try {
    return JSON.parse(body) as StreamChunk;
  } catch {
    // Tolerate a torn final write — a SIGKILL can tear the last flushed body.
    return null;
  }
}

export class TanStackRecoveryCodec implements ChatRecoveryCodec {
  /**
   * Replay the stored AG-UI chunk bodies (oldest-first) into accumulated
   * assistant text. `TEXT_MESSAGE_CONTENT` deltas concatenate; a decode failure
   * (a crash can tear the final body mid-write) stops replay, preserving the
   * prefix produced so far. Text turns produce no tool `parts`, so `parts` is
   * empty — the engine's settled-tool persist gate (`partialHasSettledToolResults`)
   * therefore reads `false`, correct for a text-only turn. (A tool turn would
   * reconstruct `parts` here — the path the harness leaves open for follow-up.)
   */
  toRecoveryPartial(bodies: string[]): RecoveryPartial {
    let text = "";
    for (const body of bodies) {
      const chunk = decodeChunk(body);
      if (!chunk) break;
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        text += chunk.delta;
      }
    }
    const parts: MessagePart[] = [];
    return { text, parts };
  }

  /**
   * The AG-UI progress vocabulary: chunk types that carry genuinely new produced
   * content (so a turn streaming them is making forward progress, not idling).
   * Mirrors `AISDKRecoveryCodec.isProgressChunk` semantics for the AG-UI event
   * names — the predicate is per-vocabulary (the codec, not the engine, owns
   * "what counts as progress").
   */
  isProgressChunk(type: string | undefined): boolean {
    return (
      type === EventType.TEXT_MESSAGE_START ||
      type === EventType.TEXT_MESSAGE_CONTENT ||
      type === EventType.TOOL_CALL_START ||
      type === EventType.TOOL_CALL_RESULT
    );
  }
}

/** Shared stateless {@link TanStackRecoveryCodec} instance. */
export const tanStackRecoveryCodec = new TanStackRecoveryCodec();
