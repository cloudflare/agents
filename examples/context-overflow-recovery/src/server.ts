import { callable, routeAgentRequest } from "agents";
import {
  Think,
  defaultContextOverflowClassifier,
  type Session
} from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";

type Env = {
  AI: Ai;
  ContextOverflowAgent: DurableObjectNamespace<ContextOverflowAgent>;
};

type CompactionEntry = {
  at: number;
  removed: number;
  reason: string;
};

/**
 * A Think agent that recovers from mid-turn context-window overflow against a
 * real Workers AI model.
 *
 * - `contextOverflow.proactive` compacts in place before a step when the
 *   previous step's reported usage approaches the budget.
 * - `contextOverflow.reactive` is the backstop: if the provider still rejects
 *   the prompt mid-turn, Think compacts and retries instead of dying.
 * - `classifyChatError` tells Think which provider errors are overflows — here
 *   we use the bundled `defaultContextOverflowClassifier`.
 *
 * Both layers reuse the session's `onCompaction` summarizer, so recovery is
 * only as good as your compaction strategy. This one collapses the oldest
 * messages into a short summary (dropping any pasted bulk), which genuinely
 * shortens the prompt so the retry fits.
 */
export class ContextOverflowAgent extends Think<Env> {
  private compactionLog: CompactionEntry[] = [];

  // Reactive backstop + a conservative proactive guard. Tune maxInputTokens to
  // your model's context window; this default is intentionally small so the
  // demo trips the guard quickly.
  override contextOverflow = {
    reactive: true,
    proactive: { maxInputTokens: 8000 }
  };

  // The bundled classifier matches the common providers' context-window errors.
  override classifyChatError = defaultContextOverflowClassifier;

  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/meta/llama-3.1-8b-instruct",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  getSystemPrompt() {
    return [
      "You are a helpful assistant demonstrating Think's context-overflow recovery.",
      "Answer normally. If the conversation gets compacted, keep going from the summary."
    ].join("\n");
  }

  override configureSession(session: Session): Session {
    return session.onCompaction(async (messages) => {
      // Keep the most recent exchange; collapse everything older into a single
      // short summary. Summarizing a RANGE (not just the first message) is what
      // actually reclaims context — including any large pasted blocks.
      const keep = 2;
      if (messages.length <= keep + 1) return null;
      const collapsed = messages.slice(0, messages.length - keep);
      this.compactionLog.push({
        at: Date.now(),
        removed: collapsed.length,
        reason: "compacted"
      });
      return {
        summary: `[Summary] ${collapsed.length} earlier message(s) were condensed to fit the model's context window.`,
        fromMessageId: collapsed[0].id,
        toMessageId: collapsed[collapsed.length - 1].id
      };
    });
  }

  /** Recent compaction events, newest last, for the demo UI. */
  @callable()
  async getCompactionLog(): Promise<CompactionEntry[]> {
    return this.compactionLog;
  }

  @callable()
  async clearCompactionLog(): Promise<void> {
    this.compactionLog = [];
  }

  /**
   * Append a large "background document" exchange to the session WITHOUT running
   * a model turn. This grows the stored history so a later (normal, small) chat
   * message overflows the window and triggers recovery. Inflating via history —
   * rather than as the triggering message — is what lets compaction reclaim
   * room: the small live message survives while the bulk is summarized away.
   * Returns the running message count so the UI can show progress.
   */
  @callable()
  async addFillerExchange(): Promise<number> {
    const big = `[Large pasted document] ${"word ".repeat(3000)}`;
    await this.session.appendMessage({
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: big }]
    });
    await this.session.appendMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "Acknowledged the document." }]
    });
    return (await this.getMessages()).length;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
