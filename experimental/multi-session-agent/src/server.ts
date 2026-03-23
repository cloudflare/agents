/**
 * Multi-Session Agent
 *
 * Single Agent with SessionManager for multiple independent chat sessions.
 * Each session has its own messages, context blocks (memory), and compaction.
 * Cross-session FTS search.
 */

import { Agent, callable, routeAgentRequest } from "agents";
import {
  SessionManager,
  AgentContextProvider,
} from "agents/experimental/memory/session";
import {
  truncateOlderMessages,
  createCompactFunction,
} from "agents/experimental/memory/utils";
import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages } from "ai";

export class MultiSessionAgent extends Agent<Env> {
  manager = new SessionManager(this, {
    sessionOptions: {
      context: [
        {
          label: "soul",
          description: "Agent identity",
          defaultContent: "You are a helpful assistant with persistent memory. Use the update_context tool to save important facts.",
          readonly: true,
        },
        {
          label: "memory",
          description: "Learned facts — save important things here",
          maxTokens: 1100,
          provider: new AgentContextProvider(this, "memory"),
        },
      ],
      promptStore: new AgentContextProvider(this, "_system_prompt"),
    },
  });

  private compactFn = createCompactFunction({
    summarize: (prompt) =>
      generateText({ model: this.getAI(), prompt }).then((r) => r.text),
    protectHead: 1,
    minTailMessages: 2,
    tailTokenBudget: 100,
  });

  private getAI() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  @callable()
  createChat(name: string) {
    return this.manager.create(name);
  }

  @callable()
  listChats() {
    return this.manager.list();
  }

  @callable()
  deleteChat(chatId: string) {
    this.manager.delete(chatId);
  }

  // ── Chat ──────────────────────────────────────────────────────

  @callable()
  async chat(chatId: string, message: string): Promise<UIMessage> {
    const session = this.manager.getSession(chatId);

    session.appendMessage({
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }],
    });

    if (this.manager.needsCompaction(chatId)) {
      await this.compact(chatId);
    }

    const history = session.getHistory();
    const truncated = truncateOlderMessages(history);

    const result = await generateText({
      model: this.getAI(),
      system: await session.context.freezeSystemPrompt(),
      messages: await convertToModelMessages(truncated),
      tools: await session.tools(),
      maxSteps: 5,
    });

    const parts: UIMessage["parts"] = [];
    for (const step of result.steps) {
      for (const tc of step.toolCalls) {
        const tr = step.toolResults.find((r) => r.toolCallId === tc.toolCallId);
        parts.push({
          type: "dynamic-tool",
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
          state: tr ? "output-available" : "input-available",
          input: tc.input,
          ...(tr ? { output: tr.output } : {}),
        } as unknown as UIMessage["parts"][number]);
      }
    }
    if (result.text) {
      parts.push({ type: "text", text: result.text });
    }

    const assistantMsg: UIMessage = {
      id: `assistant-${crypto.randomUUID()}`,
      role: "assistant",
      parts,
    };
    session.appendMessage(assistantMsg);
    return assistantMsg;
  }

  @callable()
  getHistory(chatId: string): UIMessage[] {
    return this.manager.getHistory(chatId);
  }

  @callable()
  async compact(chatId: string): Promise<{ success: boolean; removed?: number }> {
    const session = this.manager.getSession(chatId);
    const history = session.getHistory();
    if (history.length < 4) return { success: false };

    try {
      const compacted = await this.compactFn(history);
      const keptIds = new Set(compacted.map((m) => m.id));
      const removed = history.filter((m) => !keptIds.has(m.id));

      if (removed.length > 0) {
        const summaryMsg = compacted.find((m) => m.id.startsWith("compaction-summary-"));
        if (summaryMsg) {
          const summaryText = summaryMsg.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("\n");
          session.addCompaction(summaryText, removed[0].id, removed[removed.length - 1].id);
        }
        await session.context.refreshSystemPrompt();
      }
      return { success: true, removed: removed.length };
    } catch {
      return { success: false };
    }
  }

  @callable()
  searchAll(query: string) {
    return this.manager.search(query);
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
