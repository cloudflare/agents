/**
 * Deterministic faux TanStack AI model for the recovery harness.
 *
 * Emits the SAME AG-UI `StreamChunk` vocabulary a real provider does
 * (`RUN_STARTED` → `TEXT_MESSAGE_START` → `TEXT_MESSAGE_CONTENT*` →
 * `TEXT_MESSAGE_END` → `RUN_FINISHED`), but from a scripted reply at a fixed
 * `tokensPerSecond` so a turn streams over several seconds — long enough for a
 * `wrangler dev` SIGKILL to interrupt it MID-STREAM and exercise fiber recovery,
 * exactly like the pi harness's slow faux model. A deterministic body also keeps
 * the e2e's continuation math exact (`prefix + suffix === total`).
 *
 * ── Swapping in a real Workers AI provider (one line) ──────────────────────────
 * This faux stream is the ONLY non-real piece. To run against a real streaming
 * model, replace the `stream()` body with TanStack AI + the Cloudflare provider
 * (the chunk vocabulary the codec/bridge consume is identical):
 *
 *   import { chat } from "@tanstack/ai";
 *   import { createWorkersAiChat } from "@cloudflare/tanstack-ai";
 *   const adapter = createWorkersAiChat("@cf/meta/llama-4-scout-17b-16e-instruct", {
 *     binding: env.AI
 *   });
 *   return chat({ adapter, stream: true, messages }); // AsyncIterable<StreamChunk>
 *
 * The recovery assertions would then relax from exact char math to "a coherent
 * turn completes after crash + recovery" (a real model can't reproduce a
 * partial's exact suffix) — the handshake/codec seams are unchanged.
 *
 * @internal Validation fixture, not a published package.
 */

import { EventType, type StreamChunk } from "@tanstack/ai/client";

export interface FauxStreamOptions {
  threadId: string;
  runId: string;
  messageId: string;
  /** Aborts the in-flight stream (turn cancellation / fiber teardown). */
  signal?: AbortSignal;
}

/** A deterministic faux model that streams scripted AG-UI chunks slowly. */
export class FauxTanStackModel {
  private _nextText = "";

  constructor(private readonly _tokensPerSecond: number) {}

  /** Script the assistant text the NEXT turn streams. */
  setNextTurnText(text: string): void {
    this._nextText = text;
  }

  /**
   * Stream the scripted reply as AG-UI `StreamChunk`s. Each `TEXT_MESSAGE_CONTENT`
   * delta is a whitespace-preserving slice of the reply, so concatenating the
   * deltas reproduces the full text exactly (the codec relies on this).
   */
  async *stream(options: FauxStreamOptions): AsyncIterable<StreamChunk> {
    const { threadId, runId, messageId, signal } = options;
    const delayMs = Math.max(1, Math.round(1000 / this._tokensPerSecond));

    yield { type: EventType.RUN_STARTED, threadId, runId } as StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant"
    } as StreamChunk;

    for (const delta of tokenize(this._nextText)) {
      if (signal?.aborted) return;
      await sleep(delayMs, signal);
      if (signal?.aborted) return;
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta
      } as StreamChunk;
    }

    yield { type: EventType.TEXT_MESSAGE_END, messageId } as StreamChunk;
    yield { type: EventType.RUN_FINISHED, threadId, runId } as StreamChunk;
  }
}

/**
 * Split text into whitespace-preserving tokens (each piece ends at a whitespace
 * boundary), so the concatenation of all tokens is byte-identical to the input.
 */
function tokenize(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/(?<=\s)/);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
