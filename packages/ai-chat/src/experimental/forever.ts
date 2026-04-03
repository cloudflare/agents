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
 *     // Optional: override for custom recovery
 *     async onStreamInterrupted(ctx) {
 *       // re-call onChatMessage with prefill, notify user, etc.
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

export type StreamInterruptedContext = {
  streamId: string;
  requestId: string;
  partialText: string;
  partialParts: MessagePart[];
  messages: ChatMessage[];
  lastBody?: Record<string, unknown>;
  lastClientTools?: ClientToolSchema[];
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

      // Re-initialize ResumableStream with preserveStaleStreams so the
      // onStreamInterrupted hook can handle stale streams instead of
      // having them silently deleted in restore().
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

      const ctx: StreamInterruptedContext = {
        streamId,
        requestId,
        partialText: text,
        partialParts: parts,
        messages: [...this.messages],
        lastBody: this._lastBody,
        lastClientTools: this._lastClientTools
      };

      try {
        await this.onStreamInterrupted(ctx);
      } catch (e) {
        console.error("[withDurableChat] Error in onStreamInterrupted:", e);
      }

      // Clean up the interrupted stream so it doesn't trigger again
      if (
        this._resumableStream.hasActiveStream() &&
        this._resumableStream.activeStreamId === streamId
      ) {
        this._resumableStream.complete(streamId);
      }
    }

    // ── Overridable hook ────────────────────────────────────────────

    /**
     * Called when the agent restarts and detects a stream that was
     * interrupted by eviction. Override to implement recovery:
     *
     * - Re-call onChatMessage with prefilled messages
     * - Use OpenAI background mode to retrieve the completed response
     * - Notify connected clients
     *
     * Default: persists the partial response from stored chunks.
     */
    // oxlint-disable-next-line @typescript-eslint/no-unused-vars -- overridable hook
    async onStreamInterrupted(ctx: StreamInterruptedContext): Promise<void> {
      this._persistOrphanedStream(ctx.streamId);
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
  onStreamInterrupted(ctx: StreamInterruptedContext): Promise<void>;
  checkInterruptedStream(): Promise<void>;
  getPartialStreamText(streamId?: string): {
    text: string;
    parts: MessagePart[];
  };
}
