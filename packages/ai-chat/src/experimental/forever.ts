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
 * Experimental mixin for durable chat streaming with recovery after
 * DO eviction.
 *
 * Usage:
 *   import { AIChatAgent } from "@cloudflare/ai-chat";
 *   import { withDurableChat } from "@cloudflare/ai-chat/experimental/forever";
 *
 *   class MyAgent extends withDurableChat(AIChatAgent)<Env, State> {
 *     async onChatMessage(onFinish, options) { ... }
 *
 *     // Optional: override to customize recovery behavior
 *     async onChatRecovery(ctx) {
 *       // Return {} for defaults (persist partial + continue generation)
 *       // Return { continue: false } to just save the partial
 *       // Return { persist: false } if you handle persistence yourself
 *       return {};
 *     }
 *   }
 *
 * @experimental This API is not yet stable and may change.
 */
import type { UIMessage as ChatMessage } from "ai";
import type { AIChatAgent, ClientToolSchema } from "../index";
import {
  applyChunkToParts,
  ResumableStream,
  type MessagePart
} from "agents/chat";

// ── Types ─────────────────────────────────────────────────────────────

export type ChatRecoveryContext = {
  streamId: string;
  requestId: string;
  partialText: string;
  partialParts: MessagePart[];
  messages: ChatMessage[];
  lastBody?: Record<string, unknown>;
  lastClientTools?: ClientToolSchema[];
};

export type ChatRecoveryOptions = {
  /** Save the partial response from stored chunks. Default: true. */
  persist?: boolean;
  /** Schedule a continuation that appends to the interrupted message. Default: true. */
  continue?: boolean;
};

// ── Mixin ─────────────────────────────────────────────────────────────

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor pattern
type AIChatAgentConstructor = new (...args: any[]) => AIChatAgent;

let _warningShown = false;

export function withDurableChat<TBase extends typeof AIChatAgent>(Base: TBase) {
  class DurableChatAgent extends (Base as AIChatAgentConstructor) {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor
    constructor(...args: any[]) {
      super(...args);

      if (!_warningShown) {
        _warningShown = true;
        console.warn(
          "[@cloudflare/ai-chat/experimental/forever] WARNING: experimental API — will break between releases."
        );
      }

      // Re-initialize ResumableStream with preserveStaleStreams so
      // onChatRecovery can handle stale streams instead of having
      // them silently deleted in restore().
      this._resumableStream = new ResumableStream(this.sql.bind(this), {
        preserveStaleStreams: true
      });
    }

    // ── Startup detection ───────────────────────────────────────────

    override async onStart(): Promise<void> {
      await super.onStart();
      await this.checkInterruptedStream();
    }

    /**
     * Check for and handle an interrupted stream. Called automatically
     * from onStart, but can also be called manually after inserting
     * test data or after a restore.
     */
    async checkInterruptedStream(): Promise<void> {
      if (
        !this._resumableStream.hasActiveStream() ||
        this._resumableStream.isLive
      ) {
        return;
      }

      const streamId = this._resumableStream.activeStreamId!;
      const requestId = this._resumableStream.activeRequestId!;

      const { text, parts } = this.getPartialStreamText(streamId);

      const ctx: ChatRecoveryContext = {
        streamId,
        requestId,
        partialText: text,
        partialParts: parts,
        messages: [...this.messages],
        lastBody: this._lastBody,
        lastClientTools: this._lastClientTools
      };

      let options: ChatRecoveryOptions = {};
      try {
        options = (await this.onChatRecovery(ctx)) ?? {};
      } catch (e) {
        console.error("[withDurableChat] Error in onChatRecovery:", e);
      }

      if (options.persist !== false) {
        this._persistOrphanedStream(streamId);
      }

      // Clean up the interrupted stream so it doesn't trigger again
      if (
        this._resumableStream.hasActiveStream() &&
        this._resumableStream.activeStreamId === streamId
      ) {
        this._resumableStream.complete(streamId);
      }

      if (options.continue !== false) {
        await this.schedule(0, "_durableChatContinue", undefined, {
          idempotent: true
        });
      }
    }

    async _durableChatContinue(): Promise<void> {
      const ready = await this.waitUntilStable({ timeout: 10_000 });
      if (!ready) return;
      await this.continueLastTurn();
    }

    // ── Overridable hook ────────────────────────────────────────────

    /**
     * Called when the agent restarts and detects a stream that was
     * interrupted by eviction. Return options to control recovery:
     *
     * - `{ persist: true, continue: true }` (default) — save the
     *   partial response and schedule a continuation
     * - `{ continue: false }` — save the partial but don't continue
     * - `{ persist: false, continue: false }` — handle everything
     *   yourself (e.g., OpenAI background mode retrieval)
     *
     * The context includes the partial text, messages, and the
     * original request body/client tools for re-invoking onChatMessage.
     */
    async onChatRecovery(
      // oxlint-disable-next-line @typescript-eslint/no-unused-vars -- overridable hook
      _ctx: ChatRecoveryContext
    ): Promise<ChatRecoveryOptions> {
      return {};
    }

    // ── Partial text extraction ─────────────────────────────────────

    /**
     * Extract partial text and parts from stored stream chunks.
     * Rebuilds the assistant message parts by replaying chunks through
     * applyChunkToParts.
     */
    getPartialStreamText(streamId?: string): {
      text: string;
      parts: MessagePart[];
    } {
      const id = streamId ?? this._resumableStream.activeStreamId;
      if (!id) return { text: "", parts: [] };

      const chunks = this._resumableStream.getStreamChunks(id);
      const parts: MessagePart[] = [];

      for (const chunk of chunks) {
        try {
          const data = JSON.parse(chunk.body);
          applyChunkToParts(parts, data);
        } catch {
          // Skip malformed chunk bodies
        }
      }

      const text = parts
        .filter(
          (p): p is MessagePart & { type: "text"; text: string } =>
            p.type === "text" && "text" in p
        )
        .map((p) => p.text)
        .join("");

      return { text, parts };
    }
  }

  return DurableChatAgent as unknown as DurableChatAgentClass;
}

// ── Return type ───────────────────────────────────────────────────────

type DurableChatAgentClass = {
  new <Env extends Cloudflare.Env = Cloudflare.Env, State = unknown>(
    ctx: DurableObjectState,
    env: Env
  ): AIChatAgent<Env, State> & DurableChatMethods;
};

// ── Methods interface ─────────────────────────────────────────────────

export interface DurableChatMethods {
  onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions>;
  checkInterruptedStream(): Promise<void>;
  getPartialStreamText(streamId?: string): {
    text: string;
    parts: MessagePart[];
  };
  continueLastTurn(
    body?: Record<string, unknown>
  ): Promise<{ requestId: string; status: "completed" | "skipped" }>;
}
