/**
 * model — a single language-model invocation. The loop module owns iteration;
 * this seam owns translating our Part vocabulary to a provider (AI SDK,
 * direct API, …), streaming the response back, and classifying failures.
 * An adapter may internally perform multiple inferences or read-only tool
 * calls, but it must not perform mutating effects inside generate().
 *
 * Swapping providers, adding fallback/racing, or capturing fixtures for
 * tests are all implementations of this one interface.
 *
 * Allowed imports: kernel, transcript (Part vocabulary only).
 */

import type { Json, JSONSchema, TokenBudget } from "./kernel";
import type { Part, Role } from "./transcript";

export interface LanguageModelMessage {
  readonly role: Role;
  readonly parts: readonly Part[];
}

/** Tool surface as the model sees it — schema only, no execute. */
export interface LanguageModelToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly input: JSONSchema;
}

export interface LanguageModelRequest {
  readonly system?: string;
  readonly messages: readonly LanguageModelMessage[];
  readonly tools?: readonly LanguageModelToolDescriptor[];
  readonly budget?: TokenBudget;
  /** Provider-specific pass-through (temperature, headers, …). Opaque here. */
  readonly options?: Json;
}

export type LanguageModelStreamChunk =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "reasoning-delta"; readonly delta: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly input: Json;
    }
  | { readonly type: "meta"; readonly data: Json };

export type FinishReason =
  | "stop"
  | "tool-calls"
  | "length"
  | "content-filter"
  | "error";

export interface LanguageModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface LanguageModelOutput {
  readonly parts: readonly Part[];
  readonly finish: FinishReason;
  readonly usage: LanguageModelUsage;
}

export type LanguageModelErrorKind =
  | "context-overflow"
  | "rate-limit"
  | "transient"
  | "fatal";

export interface LanguageModel {
  generate(
    req: LanguageModelRequest,
    io: {
      /** Chunks forwarded to the live step buffer as they arrive. */
      onChunk?: (chunk: LanguageModelStreamChunk) => void;
      signal?: AbortSignal;
    }
  ): Promise<LanguageModelOutput>;

  /**
   * Classify a generate() failure so the loop can pick a recovery: overflow
   * → compact and retry; transient/rate-limit → retry per policy; fatal →
   * fail the step. Replaces regex-over-error-message with a port obligation.
   */
  classifyError(error: unknown): LanguageModelErrorKind;
}
