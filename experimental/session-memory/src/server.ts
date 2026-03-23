/**
 * Session Memory Example
 *
 * Demonstrates the Session API with:
 * - Context blocks (memory, todos) with frozen system prompt
 * - update_context AI tool (replace + append)
 * - Non-destructive compaction using the reference implementation
 * - Read-time tool output truncation
 * - FTS search
 */

import { Agent, callable, routeAgentRequest } from "agents";
import {
  Session,
  AgentSessionProvider,
  SqliteBlockProvider,
} from "agents/experimental/memory/session";
import {
  truncateOlderMessages,
  createCompactFunction,
} from "agents/experimental/memory/utils";
import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages } from "ai";

export class ChatAgent extends Agent<Env> {
  session = new Session(new AgentSessionProvider(this), {
    context: [
      {
        label: "soul",
        description: "Agent identity",
        defaultContent: "You are a helpful assistant with persistent memory.",
        readonly: true,
      },
      {
        label: "memory",
        description: "Learned facts — save important things here",
        maxTokens: 1100,
        provider: new SqliteBlockProvider(this, "memory"),
      },
      {
        label: "todos",
        description: "Task list",
        maxTokens: 2000,
        provider: new SqliteBlockProvider(this, "todos"),
      },
    ],
  });

  // Reference compaction: head/tail protection, structured summary,
  // iterative updates, tool pair sanitization
  private compactFn = createCompactFunction({
    summarize: (prompt) =>
      generateText({ model: this.getAI(), prompt }).then((r) => r.text),
  });

  async onStart() {
    await this.session.init();
  }

  private getAI() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  @callable()
  async chat(message: string): Promise<string> {
    this.session.appendMessage({
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }],
    });

    // Auto-compact if conversation is long
    if (this.session.needsCompaction(30)) {
      await this.compact();
    }

    const history = this.session.getHistory();
    const truncated = truncateOlderMessages(history);

    const { text } = await generateText({
      model: this.getAI(),
      system: this.session.toSystemPrompt(),
      messages: await convertToModelMessages(truncated),
      tools: this.session.tools(),
      maxSteps: 5,
    });

    this.session.appendMessage({
      id: `assistant-${crypto.randomUUID()}`,
      role: "assistant",
      parts: [{ type: "text", text }],
    });

    return text;
  }

  /**
   * Run compaction using the reference implementation.
   * Protects head + tail, summarizes middle with structured prompt,
   * aligns boundaries to tool call groups, sanitizes orphaned pairs.
   */
  @callable()
  async compact(): Promise<{ success: boolean }> {
    const history = this.session.getHistory();
    if (history.length < 6) return { success: false };

    try {
      const compacted = await this.compactFn(history);

      // The reference implementation returns the compacted messages.
      // Find what was removed and overlay a compaction record.
      const keptIds = new Set(compacted.map((m) => m.id));
      const removed = history.filter((m) => !keptIds.has(m.id));

      if (removed.length > 0) {
        // Find the summary message (added by createCompactFunction)
        const summaryMsg = compacted.find((m) =>
          m.id.startsWith("compaction-summary-")
        );
        if (summaryMsg) {
          const summaryText = summaryMsg.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("\n");

          this.session.addCompaction(
            summaryText,
            removed[0].id,
            removed[removed.length - 1].id
          );
        }
      }

      return { success: true };
    } catch {
      return { success: false };
    }
  }

  @callable()
  getHistory(): UIMessage[] {
    return this.session.getHistory();
  }

  // Client UI calls getMessages — alias to getHistory
  @callable()
  getMessages(): UIMessage[] {
    return this.session.getHistory();
  }

  @callable()
  search(query: string) {
    return this.session.search(query);
  }

  @callable()
  clearMessages(): void {
    this.session.clearMessages();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
};
