import { Think } from "@cloudflare/think";
import type { ToolSet } from "ai";

export class ConversationAgent extends Think {
  override getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
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
