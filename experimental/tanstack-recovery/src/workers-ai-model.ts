/**
 * The REAL Workers AI provider for the recovery harness (opt-in).
 *
 * This is the "one-line swap" `faux-model.ts` documents, made concrete: it runs
 * `@tanstack/ai`'s `chat()` over `@cloudflare/tanstack-ai`'s `createWorkersAiChat`
 * adapter bound to the `AI` binding, and yields the SAME AG-UI `StreamChunk`
 * vocabulary the faux model does. So the recovery codec, the `ws-bridge`, and the
 * shared `ResumeHandshake`/`ChatRecoveryEngine` consume an identical stream shape
 * — the only difference is that the chunks now come from a real, non-deterministic
 * model rather than a scripted one. This is the single genuinely-untested codec
 * axis (rfc-chat-recovery-foundation, Phase 5 "Second harness").
 *
 * Used only by the `RUN_WORKERS_AI_E2E`-gated e2e; the faux model stays the
 * default for CI. `wrangler dev`'s `AI` binding (`remote: true`) proxies to real
 * Workers AI, so this path needs network + Cloudflare auth.
 *
 * @internal Validation fixture, not a published package.
 */

import { createWorkersAiChat } from "@cloudflare/tanstack-ai";
import { chat, type StreamChunk } from "@tanstack/ai";
import type { TurnModel, TurnStreamOptions } from "./model";

/** The Workers AI text model the harness exercises (matches the repo examples). */
export const WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.7-code";

/**
 * Wrap a Workers AI `AI` binding as a {@link TurnModel}. The adapter speaks the
 * AG-UI protocol through `chat()`, so the returned stream is the same
 * `AsyncIterable<StreamChunk>` the codec/bridge already handle.
 */
export function createWorkersAiModel(binding: Ai): TurnModel {
  const adapter = createWorkersAiChat(WORKERS_AI_MODEL, { binding });
  return {
    stream(options: TurnStreamOptions): AsyncIterable<StreamChunk> {
      const controller = new AbortController();
      options.signal?.addEventListener("abort", () => controller.abort(), {
        once: true
      });
      return chat({
        adapter,
        stream: true,
        messages: options.messages ?? [],
        systemPrompts: options.systemPrompt
          ? [options.systemPrompt]
          : undefined,
        threadId: options.threadId,
        runId: options.runId,
        abortController: controller
      });
    }
  };
}
