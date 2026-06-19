/**
 * `TanStackRecoveryCodec` — the TanStack/AG-UI half of the streaming-codec seam.
 *
 * The shared recovery engine reconstructs an interrupted turn's partial assistant
 * state by replaying a durable stream buffer through a {@link ChatRecoveryCodec}.
 * The AI SDK adapter (`AISDKRecoveryCodec`) replays AI-SDK SSE chunks; pi replays
 * its own `AgentEvent` vocabulary; this one replays the AG-UI `StreamChunk`
 * vocabulary a TanStack AI client/provider speaks (`TEXT_MESSAGE_CONTENT` deltas,
 * `TOOL_CALL_*`, …). All three feed the engine the identical `RecoveryPartial`
 * shape (`{ text, parts, hasSettledToolResults }`), so the engine never sees the
 * wire vocabulary — the codec owns the chunk-shape differences. This is the
 * second genericity axis the pi fixture left untested: a foreign streaming chunk
 * vocabulary, not pi's events (rfc-chat-recovery-foundation, Phase 5 second harness).
 *
 * The codec rebuilds BOTH halves of a recovered partial: assistant `text` (from
 * `TEXT_MESSAGE_CONTENT` deltas) and tool `parts` (from the AG-UI
 * `TOOL_CALL_START → ARGS → END → RESULT` sub-protocol) — in its OWN AG-UI-native
 * shape, NOT AI SDK's `UIMessage` parts. Because the engine seam is
 * vocabulary-agnostic (`parts: unknown[]` + a precomputed `hasSettledToolResults`
 * boolean), the codec decides settledness itself and never fabricates an AI-SDK
 * part. That boolean is what lets the engine's SHARED settled-tool persist gate
 * preserve a foreign tool's completed (non-idempotent) result under a
 * `{ persist: false }` recovery policy, exactly as it does for AI-SDK tools —
 * with zero AI-SDK coupling in this codec.
 *
 * @internal Validation fixture, not a published package.
 */

import { EventType, type StreamChunk } from "@tanstack/ai/client";
import type { ChatRecoveryCodec, RecoveryPartial } from "agents/chat";

/** Parse one stored chunk body back into an AG-UI `StreamChunk`, or `null`. */
function decodeChunk(body: string): StreamChunk | null {
  try {
    return JSON.parse(body) as StreamChunk;
  } catch {
    // Tolerate a torn final write — a SIGKILL can tear the last flushed body.
    return null;
  }
}

/** Parse the accumulated `TOOL_CALL_ARGS` buffer as JSON, falling back to raw. */
function parseArgs(buffer: string): unknown {
  if (buffer.length === 0) return undefined;
  try {
    return JSON.parse(buffer);
  } catch {
    return buffer;
  }
}

/**
 * A reconstructed AG-UI tool part — the harness's OWN vocabulary, NOT AI SDK's
 * `UIMessage` part shape. The engine seam (`RecoveryPartial.parts`) is opaque
 * (`unknown[]`), so the codec never has to fabricate AI-SDK parts; it returns
 * readable AG-UI-native parts and decides settledness itself (`hasOutput`). This
 * is the whole point of the agnostic seam: the foreign codec owns its vocabulary
 * end-to-end. `argsBuffer` accumulates the streamed `TOOL_CALL_ARGS` deltas so
 * the input can be parsed once on `TOOL_CALL_END`.
 */
interface TanStackToolPart {
  toolCallId: string;
  toolName: string;
  argsBuffer: string;
  input: unknown;
  hasOutput: boolean;
  output: unknown;
}

export class TanStackRecoveryCodec implements ChatRecoveryCodec {
  /**
   * Replay the stored AG-UI chunk bodies (oldest-first) into accumulated
   * assistant text AND reconstructed tool `parts` (in the harness's OWN AG-UI
   * vocabulary — no AI-SDK `MessagePart` fabrication). `TEXT_MESSAGE_CONTENT`
   * deltas concatenate into `text`; the `TOOL_CALL_*` sub-protocol
   * (`START → ARGS* → END → RESULT`) rebuilds each tool part. A decode failure (a
   * crash can tear the final body mid-write) stops replay, preserving whatever
   * text + tool parts survived — so a tool whose `RESULT` already flushed reads
   * as **settled** (`hasOutput`), while a tool torn before its result reads as
   * **unsettled**. The codec — not the engine — decides `hasSettledToolResults`
   * from its own vocabulary, proving the engine's settled-tool persist gate is
   * wire-agnostic: it consumes the boolean, never an AI-SDK part shape.
   */
  toRecoveryPartial(bodies: string[]): RecoveryPartial {
    let text = "";
    const parts: TanStackToolPart[] = [];
    const draftById = new Map<string, TanStackToolPart>();

    for (const body of bodies) {
      const chunk = decodeChunk(body);
      if (!chunk) break;
      switch (chunk.type) {
        case EventType.TEXT_MESSAGE_CONTENT:
          text += chunk.delta;
          break;
        case EventType.TOOL_CALL_START: {
          const start = chunk as {
            toolCallId: string;
            toolCallName?: string;
            toolName?: string;
          };
          if (draftById.has(start.toolCallId)) break;
          const draft: TanStackToolPart = {
            toolCallId: start.toolCallId,
            toolName: start.toolCallName ?? start.toolName ?? "tool",
            argsBuffer: "",
            input: undefined,
            hasOutput: false,
            output: undefined
          };
          parts.push(draft);
          draftById.set(start.toolCallId, draft);
          break;
        }
        case EventType.TOOL_CALL_ARGS: {
          const args = chunk as { toolCallId: string; delta?: string };
          const draft = draftById.get(args.toolCallId);
          if (draft) draft.argsBuffer += args.delta ?? "";
          break;
        }
        case EventType.TOOL_CALL_END: {
          const end = chunk as { toolCallId: string };
          const draft = draftById.get(end.toolCallId);
          if (draft) draft.input = parseArgs(draft.argsBuffer);
          break;
        }
        case EventType.TOOL_CALL_RESULT: {
          const result = chunk as { toolCallId: string; content?: unknown };
          const draft = draftById.get(result.toolCallId);
          if (draft) {
            draft.hasOutput = true;
            draft.output = result.content;
          }
          break;
        }
        default:
          break;
      }
    }

    // The codec owns "settled?" for its OWN vocabulary: any tool whose RESULT
    // flushed (`hasOutput`) is settled, non-idempotent work the engine must
    // preserve under `{ persist: false }`.
    const hasSettledToolResults = parts.some((part) => part.hasOutput);
    return { text, parts, hasSettledToolResults };
  }

  /**
   * AG-UI progress MILESTONES: started segments and settled tool start/result —
   * the chunk types that always credit forward progress. Mirrors
   * `AISDKRecoveryCodec.isProgressChunk` semantics for the AG-UI event names
   * (`TEXT_MESSAGE_START` ↔ `text-start`, `TOOL_CALL_START`/`TOOL_CALL_RESULT` ↔
   * the settled-tool milestones). Disjoint from {@link isStreamingContentChunk}.
   */
  isProgressChunk(type: string | undefined): boolean {
    return (
      type === EventType.TEXT_MESSAGE_START ||
      type === EventType.TOOL_CALL_START ||
      type === EventType.TOOL_CALL_RESULT
    );
  }

  /**
   * AG-UI mid-segment streaming content: text-body and tool-arg deltas
   * (`TEXT_MESSAGE_CONTENT` ↔ `text-delta`, `TOOL_CALL_ARGS` ↔ `tool-input-delta`).
   * Credited through the host's progress throttle so a long single segment still
   * registers progress across crashes without writing storage per chunk.
   */
  isStreamingContentChunk(type: string | undefined): boolean {
    return (
      type === EventType.TEXT_MESSAGE_CONTENT ||
      type === EventType.TOOL_CALL_ARGS
    );
  }
}

/** Shared stateless {@link TanStackRecoveryCodec} instance. */
export const tanStackRecoveryCodec = new TanStackRecoveryCodec();
