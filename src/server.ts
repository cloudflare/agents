import { Think } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import { Session as SessionWithoutChangeEvents } from "agents-session-without-change-events/experimental/memory/session";
import type { LanguageModel } from "ai";

type Env = {
  ReproThink: DurableObjectNamespace<ReproThink>;
};

const REPLY = "deterministic assistant reply for issue 2132";

const finishReason = { unified: "stop" as const, raw: undefined };
const usage = {
  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 }
};

/** A provider-free AI SDK v3 model, adapted from Think's own worker tests. */
function deterministicModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "repro",
    modelId: "deterministic-repro-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("This reproduction only uses streaming generation");
    },
    doStream() {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "reply-text" });
          await new Promise((resolve) => setTimeout(resolve, 120));
          controller.enqueue({
            type: "text-delta",
            id: "reply-text",
            delta: "deterministic assistant "
          });
          await new Promise((resolve) => setTimeout(resolve, 120));
          controller.enqueue({
            type: "text-delta",
            id: "reply-text",
            delta: "reply for issue 2132"
          });
          controller.enqueue({ type: "text-end", id: "reply-text" });
          controller.enqueue({ type: "finish", finishReason, usage });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

export class ReproThink extends Think<Env> {
  // The old Session has no budgeted read API; this asks Think to use getHistory.
  override hydrationByteBudget = 0;

  override getModel(): LanguageModel {
    return deterministicModel();
  }

  override getSystemPrompt(): string {
    return "Return the deterministic reproduction reply.";
  }

  /**
   * Recreate the affected configuration: an external Session implementation
   * that predates Think's private internal_onMessagesChanged hook. Think 0.16's
   * public configureSession contract permits returning a Session, but the
   * runtime assumes the private hook exists and otherwise never mirrors writes.
   */
  override configureSession(_base: unknown): any {
    const session = SessionWithoutChangeEvents.create(this as any) as any;
    // Think calls this private hook unconditionally. Older/external Session
    // implementations do not have it; a no-op compatibility shim is enough to
    // let the app boot, but it also exposes the cache-coherence assumption.
    session.internal_onMessagesChanged = () => session;
    return session;
  }

  /**
   * Run the same turn path as the WebSocket protocol, but return only after
   * persistence. This makes the stale-cache state directly observable before
   * any reconnect can accidentally force a fresh isolate hydration.
   */
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/run-and-inspect")) {
      await this.chat("Please reproduce issue 2132.", {
        onStart() {},
        onEvent() {},
        onDone() {},
        onError(error: string) {
          throw new Error(error);
        }
      });
      const internals = this as unknown as { _cachedMessages: unknown[] };
      return Response.json({
        expectedReply: REPLY,
        liveCache: this.messages,
        rawCachedMessages: internals._cachedMessages,
        sameReference: this.messages === internals._cachedMessages,
        durableHistory: await this.session.getHistory()
      });
    }
    if (url.pathname.endsWith("/diagnostic")) {
      return Response.json({
        expectedReply: REPLY,
        liveCache: this.messages,
        durableHistory: await this.session.getHistory()
      });
    }
    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
