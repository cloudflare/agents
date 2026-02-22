/**
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * !! WARNING: EXPERIMENTAL — DO NOT USE IN PRODUCTION                  !!
 * !!                                                                   !!
 * !! This API is under active development and WILL break between       !!
 * !! releases. Method names, types, behavior, and the mixin signature  !!
 * !! are all subject to change without notice.                         !!
 * !!                                                                   !!
 * !! If you use this, pin your @cloudflare/ai-chat version and expect  !!
 * !! to rewrite your code when upgrading.                              !!
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 *
 * Experimental mixin for durable chat streaming.
 *
 * Usage:
 *   import { AIChatAgent } from "@cloudflare/ai-chat";
 *   import { withDurableChat } from "@cloudflare/ai-chat/experimental/forever";
 *
 *   class MyAgent extends withDurableChat(AIChatAgent)<Env, State> {
 *     async onChatMessage(onFinish, options) { ... }
 *   }
 *
 * This mixin adds:
 * - keepAlive during streaming — DO stays alive while LLM generates
 * - (planned) getPartialStreamText() — extract partial response from chunks
 * - (planned) onStreamInterrupted() — hook for recovery after eviction
 *
 * @experimental This API is not yet stable and may change.
 */
import { keepAlive } from "agents/experimental/forever";
import type { AIChatAgent } from "../index";

console.warn(
  "[@cloudflare/ai-chat/experimental/forever] WARNING: You are using an experimental API that WILL break between releases. Do not use in production."
);

// ── Mixin ─────────────────────────────────────────────────────────────

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

type AIChatAgentLike = Constructor<
  Pick<AIChatAgent, "scheduleEvery" | "cancelSchedule">
>;

export function withDurableChat<TBase extends AIChatAgentLike>(Base: TBase) {
  class DurableChatAgent extends Base {
    /**
     * No-op heartbeat callback. The schedule itself keeps the DO alive;
     * the callback doesn't need to do anything.
     * @internal
     */
    // oxlint-disable-next-line @typescript-eslint/no-empty-function
    _cf_streamKeepAlive() {}

    /**
     * Keep the DO alive during streaming.
     * Returns a disposer that cancels the heartbeat schedule.
     */
    async keepAlive(): Promise<() => void> {
      return keepAlive(this, "_cf_streamKeepAlive");
    }
  }

  return DurableChatAgent;
}
