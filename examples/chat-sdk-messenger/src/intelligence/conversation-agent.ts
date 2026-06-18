import { Think } from "@cloudflare/think";
import type { LanguageModel, ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export class ConversationAgent extends Think {
  override getModel(): LanguageModel {
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai("@cf/moonshotai/kimi-k2.7-code", {
      sessionAffinity: this.sessionAffinity
    });
  }

  override getSystemPrompt(): string {
    return [
      "You are a concise assistant replying inside a chat thread.",
      "Answer the user's latest message directly.",
      "Use plain text or simple Markdown only.",
      "Do not expose hidden reasoning, tool calls, or internal state."
    ].join("\n");
  }

  override getTools(): ToolSet {
    return {};
  }

  async resetConversation(): Promise<void> {
    await this.clearMessages();
  }
}
