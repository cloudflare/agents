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
import type { RecoveryPartial } from "./recovery-engine";

/**
 * Reconstructs the partial assistant state of an interrupted turn from its
 * stored `ResumableStream` chunk bodies (oldest-first).
 */
export interface ChatRecoveryCodec {
  /** Replay the stored chunk bodies into the engine's `RecoveryPartial`. */
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
  toRecoveryPartial(bodies: string[]): RecoveryPartial {
    return getPartialStreamText(bodies.map((body) => ({ body })));
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
