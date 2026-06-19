/**
 * The turn-model seam for the recovery harness.
 *
 * A `TurnModel` is anything that streams a reply as AG-UI `StreamChunk`s — the
 * SAME vocabulary the codec, the `ws-bridge`, and the shared `ResumeHandshake`
 * already consume. Two implementations exist:
 *
 *  - {@link FauxTanStackModel} (the DEFAULT, deterministic): scripts a slow,
 *    reproducible reply so the SIGKILL e2e's continuation math is exact. Used by
 *    CI and every offline run.
 *  - the real Workers AI provider (`workers-ai-model.ts`, OPT-IN): runs
 *    `@tanstack/ai`'s `chat()` over `@cloudflare/tanstack-ai`'s
 *    `createWorkersAiChat` adapter against the `AI` binding. Non-deterministic;
 *    exercised only by the `RUN_WORKERS_AI_E2E`-gated e2e.
 *
 * Because `chat({ adapter, stream: true })` yields `AsyncIterable<StreamChunk>` —
 * byte-identical to the faux model's output — swapping providers is model-only:
 * the recovery codec/handshake/engine never observe the difference.
 *
 * @internal Validation fixture, not a published package.
 */

import type { ModelMessage, StreamChunk } from "@tanstack/ai";

export interface TurnStreamOptions {
  threadId: string;
  runId: string;
  messageId: string;
  /**
   * Conversation messages for a REAL provider. The faux model ignores these
   * (it streams its scripted `setNextTurnText`); the Workers AI model turns them
   * into the prompt — including an assistant-prefill continuation message on a
   * recovery re-run (see `workers-ai-model.ts`).
   */
  messages?: ModelMessage[];
  /** System guidance for a real provider; ignored by the faux model. */
  systemPrompt?: string;
  /** Aborts the in-flight stream (turn cancellation / fiber teardown). */
  signal?: AbortSignal;
}

/** Streams a turn's reply as AG-UI `StreamChunk`s. */
export interface TurnModel {
  stream(options: TurnStreamOptions): AsyncIterable<StreamChunk>;
}

/** The per-turn model provider, stored durably so a cold-wake recovery re-runs
 *  the SAME provider it crashed under. */
export type TurnProvider = "faux" | "workers-ai";
