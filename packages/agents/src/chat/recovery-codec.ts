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
   * Whether a stored chunk of this wire `type` represents genuinely new produced
   * content — a started text/reasoning segment or a settled tool input/output —
   * that should credit the host's recovery no-progress window (#1637). The
   * chunk-type list lives HERE (the codec owns the chunk vocabulary); each host
   * still decides WHEN to consult it at its existing bump site, so the bump
   * TIMING stays host-owned. A `undefined` type (a non-JSON / typeless body) is
   * never progress.
   */
  isProgressChunk(type: string | undefined): boolean;
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
}

/** Shared stateless {@link AISDKRecoveryCodec} instance. */
export const aiSdkRecoveryCodec = new AISDKRecoveryCodec();
