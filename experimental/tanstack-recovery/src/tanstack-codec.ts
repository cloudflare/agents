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
 * The codec rebuilds BOTH halves of a recovered partial: assistant `text` (from
 * `TEXT_MESSAGE_CONTENT` deltas) and tool `parts` (from the AG-UI
 * `TOOL_CALL_START → ARGS → END → RESULT` sub-protocol, materialized into the
 * AI-SDK `UIMessage` tool-part shape). Reconstructing `parts` is what lets the
 * engine's SHARED settled-tool persist gate — `partialHasSettledToolResults` —
 * preserve a foreign tool's completed (non-idempotent) result even under a
 * `{ persist: false }` recovery policy, exactly as it does for AI-SDK tools.
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
 * A tool part under construction while replaying AG-UI `TOOL_CALL_*` chunks.
 * `argsBuffer` accumulates the streamed `TOOL_CALL_ARGS` deltas so the final
 * input can be parsed once on `TOOL_CALL_END`.
 */
interface ToolPartDraft {
  toolCallId: string;
  toolName: string;
  argsBuffer: string;
  input: unknown;
  hasOutput: boolean;
  output: unknown;
}

/**
 * Materialize a draft into the AI-SDK `UIMessage` tool-part shape the engine's
 * settled-tool gate (`partialHasSettledToolResults`) reads: `type: "tool-<name>"`,
 * `output` present (and `state: "output-available"`) once a `TOOL_CALL_RESULT`
 * landed, else an in-flight `input-available` part with no output. The byte
 * shape mirrors `applyChunkToParts` in `agents/chat` so the SAME shared
 * predicate classifies both vocabularies identically.
 */
function materializeToolPart(draft: ToolPartDraft): MessagePart {
  if (draft.hasOutput) {
    return {
      type: `tool-${draft.toolName}`,
      toolCallId: draft.toolCallId,
      toolName: draft.toolName,
      state: "output-available",
      input: draft.input,
      output: draft.output
    } as unknown as MessagePart;
  }
  return {
    type: `tool-${draft.toolName}`,
    toolCallId: draft.toolCallId,
    toolName: draft.toolName,
    state: "input-available",
    input: draft.input
  } as unknown as MessagePart;
}

export class TanStackRecoveryCodec implements ChatRecoveryCodec {
  /**
   * Replay the stored AG-UI chunk bodies (oldest-first) into accumulated
   * assistant text AND reconstructed tool `parts`. `TEXT_MESSAGE_CONTENT` deltas
   * concatenate into `text`; the `TOOL_CALL_*` sub-protocol
   * (`START → ARGS* → END → RESULT`) rebuilds each tool part. A decode failure (a
   * crash can tear the final body mid-write) stops replay, preserving whatever
   * text + tool parts survived — so a tool whose `RESULT` already flushed reads
   * as **settled** (`output` present), while a tool torn before its result reads
   * as **unsettled** (no `output`). This is exactly what the engine's shared
   * settled-tool persist gate (`partialHasSettledToolResults`) keys off, proving
   * the gate works against a foreign tool vocabulary, not just AI-SDK SSE.
   */
  toRecoveryPartial(bodies: string[]): RecoveryPartial {
    let text = "";
    const drafts: ToolPartDraft[] = [];
    const draftById = new Map<string, ToolPartDraft>();

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
          const draft: ToolPartDraft = {
            toolCallId: start.toolCallId,
            toolName: start.toolCallName ?? start.toolName ?? "tool",
            argsBuffer: "",
            input: undefined,
            hasOutput: false,
            output: undefined
          };
          drafts.push(draft);
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

    const parts = drafts.map(materializeToolPart);
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
