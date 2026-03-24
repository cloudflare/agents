/**
 * Session Memory Example
 *
 * Demonstrates the Session API with:
 * - Context blocks (memory, todos) with frozen system prompt
 * - update_context AI tool (replace + append)
 * - Non-destructive compaction using the reference implementation
 * - Read-time tool output truncation
 */

import { Agent, callable, routeAgentRequest } from "agents";
import { Session } from "agents/experimental/memory/session";
import {
  truncateOlderMessages,
  createCompactFunction
} from "agents/experimental/memory/utils";
import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages, stepCountIs } from "ai";

export class ChatAgent extends Agent<Env> {
  session = Session.create(this)
    .withContext("soul", {
      initialContent:
        "You are a helpful assistant with persistent memory. Use the update_context tool to save important facts to memory and manage your todo list.",
      readonly: true
    })
    .withContext("memory", {
      description: "Learned facts — save important things here",
      maxTokens: 1100
    })
    .withContext("todos", {
      description: "Task list",
      maxTokens: 2000
    })
    .withCachedPrompt();

  private compactFn = createCompactFunction({
    summarize: (prompt) =>
      generateText({ model: this.getAI(), prompt }).then((r) => r.text),
    protectHead: 1,
    minTailMessages: 2,
    tailTokenBudget: 100
  });

  private getAI() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  @callable()
  async chat(message: string, messageId?: string): Promise<UIMessage> {
    this.session.appendMessage({
      id: messageId ?? `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }]
    });

    // Auto-compact after 6 messages so it's easy to demo
    if (this.session.needsCompaction(6)) {
      await this.compact();
    }

    const history = this.session.getHistory();
    const truncated = truncateOlderMessages(history);

    const result = await generateText({
      model: this.getAI(),
      system: await this.session.freezeSystemPrompt(),
      messages: await convertToModelMessages(truncated),
      tools: await this.session.tools(),
      stopWhen: stepCountIs(5)
    });

    // Build a single assistant UIMessage with all parts.
    // Tool parts use type "dynamic-tool" with state "output-available".
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
          ...(tr ? { output: tr.output } : {})
        } as unknown as UIMessage["parts"][number]);
      }
    }

    if (result.text) {
      parts.push({ type: "text", text: result.text });
    }

    const assistantMsg: UIMessage = {
      id: `assistant-${crypto.randomUUID()}`,
      role: "assistant",
      parts
    };

    this.session.appendMessage(assistantMsg);
    return assistantMsg;
  }

  @callable()
  async compact(): Promise<{ success: boolean; removed?: number }> {
    const history = this.session.getHistory();
    if (history.length < 4) return { success: false };

    try {
      const compacted = await this.compactFn(history);
      const keptIds = new Set(compacted.map((m) => m.id));
      const removed = history.filter(
        (m) => !keptIds.has(m.id) && !m.id.startsWith("compaction_")
      );

      if (removed.length > 0) {
        const summaryMsg = compacted.find((m) =>
          m.id.startsWith("compaction-summary-")
        );
        if (summaryMsg) {
          const summaryText = summaryMsg.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("\n");

          // New summary incorporates previous summaries, so the compaction
          // range should start where the earliest existing compaction started.
          // This ensures the new overlay supersedes old ones in applyCompactions.
          const existing = this.session.getCompactions();
          const fromId =
            existing.length > 0 ? existing[0].fromMessageId : removed[0].id;

          this.session.addCompaction(
            summaryText,
            fromId,
            removed[removed.length - 1].id
          );
        }

        // Compaction busts the prefix cache anyway — refresh system prompt
        // to pick up any context block writes from this session
        await this.session.refreshSystemPrompt();
      }

      return { success: true, removed: removed.length };
    } catch {
      return { success: false };
    }
  }

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
  }
};
