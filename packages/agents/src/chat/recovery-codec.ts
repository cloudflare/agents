/**
 * `ChatRecoveryCodec` — the streaming-codec seam the recovery engine replays an
 * interrupted turn's durable buffer through to reconstruct its partial assistant
 * state. The engine and hosts only ever see the wire-agnostic `RecoveryPartial`
 * shape (`{ text, parts }`); the codec owns the chunk-vocabulary differences.
 *
 * Two implementations exist today: {@link AISDKRecoveryCodec} (AI SDK SSE chunks,
 * used by `@cloudflare/ai-chat` and `@cloudflare/think`) and `PiRecoveryCodec`
 * (the pi `AgentEvent` vocabulary, in the `experimental/pi-recovery` fixture).
 * Formalizing the interface here is the proof that the codec — not the engine —
 * carries the chunk-shape contract.
 *
 * @internal Shared chat-recovery internals; not a public API.
 */

import { getPartialStreamText } from "./message-builder";
import type { MessagePart } from "./message-builder";
import type { RecoveryPartial } from "./recovery-engine";

/**
 * Whether a reconstructed AI SDK `UIMessage` parts array carries any settled
 * (provider-accepted) tool result — the completed, often non-idempotent work
 * that a `{ persist: false }` recovery return would otherwise silently discard
 * (#1631). A part counts as settled when it is a tool part (`tool-*` /
 * `dynamic-tool`) carrying an `output`/`result`, or whose state reached a
 * terminal `output-{available,error,denied}`.
 *
 * This is the AI SDK codec's implementation of the per-vocabulary "did this
 * partial settle a tool?" question. It lives with {@link AISDKRecoveryCodec}
 * (not in the engine) because the codec owns the part vocabulary — the engine
 * only ever reads the precomputed `RecoveryPartial.hasSettledToolResults`
 * boolean and never names a part type. Foreign codecs (e.g. AG-UI) compute the
 * same boolean from their own chunk vocabulary without producing AI SDK parts.
 */
export function partialHasSettledToolResults(parts: MessagePart[]): boolean {
  return parts.some((part) => {
    const record = part as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (!(type.startsWith("tool-") || type === "dynamic-tool")) return false;
    if ("output" in record || "result" in record) return true;
    const state = typeof record.state === "string" ? record.state : "";
    return (
      state === "output-available" ||
      state === "output-error" ||
      state === "output-denied"
    );
  });
}

/**
 * Reconstructs the partial assistant state of an interrupted turn from its
 * stored `ResumableStream` chunk bodies (oldest-first).
 */
export interface ChatRecoveryCodec {
  /**
   * Replay the stored chunk bodies into the engine's `RecoveryPartial`. The
   * codec — not the engine — both reconstructs `parts` (in its own vocabulary,
   * opaque to the engine) AND decides `hasSettledToolResults`, so the engine
   * never names a part type.
   */
  toRecoveryPartial(bodies: string[]): RecoveryPartial;
  /**
   * Whether a stored chunk of this wire `type` is a **progress milestone** — a
   * started text/reasoning segment or a settled tool input/output — that should
   * always credit the host's recovery no-progress window (#1637). The chunk-type
   * list lives HERE (the codec owns the chunk vocabulary). A `undefined` type (a
   * non-JSON / typeless body) is never progress.
   */
  isProgressChunk(type: string | undefined): boolean;
  /**
   * Whether a stored chunk of this wire `type` is **mid-segment streaming
   * content** — a delta extending an already-started segment (text/reasoning
   * body, partial tool input). On its own a delta is too granular to credit per
   * token, but a long single segment that produces only deltas (no new
   * milestone) must still register forward progress across repeated crashes, or
   * its no-progress window can false-fire while content is genuinely streaming.
   * Hosts credit these through a time throttle (see {@link
   * shouldCreditStreamProgress}). Disjoint from {@link isProgressChunk}; a
   * `undefined` type is never streaming content.
   */
  isStreamingContentChunk(type: string | undefined): boolean;
}

/** Minimal per-isolate throttle gate (see `StreamProgressCreditThrottle`). */
export interface ProgressCreditThrottle {
  shouldCredit(now: number): boolean;
}

/**
 * The single, host-agnostic rule for crediting recovery forward progress from a
 * stored stream chunk — the convergence of what `AIChatAgent` and `Think`
 * previously each decided on their own (ai-chat keyed on chunk type only; Think
 * keyed on its flush cadence). Both hosts now call this at chunk-store time so
 * the bump TIMING is identical:
 *
 *  - a **milestone** ({@link ChatRecoveryCodec.isProgressChunk}) always credits;
 *  - **streaming content** ({@link ChatRecoveryCodec.isStreamingContentChunk})
 *    credits at most once per throttle window, so a long single segment still
 *    registers progress across crashes without writing storage per token;
 *  - anything else never credits.
 *
 * Finer than either host's prior cadence in the worst case and never coarser, so
 * it can only delay/avoid a false `no_progress_timeout`, never hasten give-up.
 */
export function shouldCreditStreamProgress(input: {
  codec: Pick<ChatRecoveryCodec, "isProgressChunk" | "isStreamingContentChunk">;
  type: string | undefined;
  throttle: ProgressCreditThrottle;
  now: number;
}): boolean {
  const { codec, type, throttle, now } = input;
  if (codec.isProgressChunk(type)) return true;
  if (codec.isStreamingContentChunk(type)) return throttle.shouldCredit(now);
  return false;
}

/**
 * The AI SDK codec: replays SSE chunk bodies through {@link getPartialStreamText}
 * (`applyChunkToParts` under the hood). Stateless — share the
 * {@link aiSdkRecoveryCodec} singleton rather than constructing per call.
 */
export class AISDKRecoveryCodec implements ChatRecoveryCodec {
  // Return type is intentionally INFERRED (not annotated `RecoveryPartial`) so it
  // keeps the concrete `parts: MessagePart[]`, which the AI SDK hosts' own
  // `_getPartialStreamText` callers rely on. It is still assignable to
  // `RecoveryPartial` (whose `parts` is `unknown[]`), so the engine seam stays
  // vocabulary-agnostic while AI SDK callers keep their typed parts.
  toRecoveryPartial(bodies: string[]): {
    text: string;
    parts: MessagePart[];
    hasSettledToolResults: boolean;
  } {
    const { text, parts } = getPartialStreamText(
      bodies.map((body) => ({ body }))
    );
    return {
      text,
      parts,
      hasSettledToolResults: partialHasSettledToolResults(parts)
    };
  }

  isProgressChunk(type: string | undefined): boolean {
    return (
      type === "text-start" ||
      type === "reasoning-start" ||
      type === "tool-input-available" ||
      type === "tool-output-available" ||
      type === "tool-output-error" ||
      type === "tool-output-denied"
    );
  }

  isStreamingContentChunk(type: string | undefined): boolean {
    return (
      type === "text-delta" ||
      type === "reasoning-delta" ||
      type === "tool-input-delta"
    );
  }
}

/** Shared stateless {@link AISDKRecoveryCodec} instance. */
export const aiSdkRecoveryCodec = new AISDKRecoveryCodec();
