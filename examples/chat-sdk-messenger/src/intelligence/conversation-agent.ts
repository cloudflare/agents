import { Think } from "@cloudflare/think";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { extractLatestAssistantText } from "./messages";

export class ConversationAgent extends Think {
  override getModel(): LanguageModel {
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai("@cf/moonshotai/kimi-k2.6", {
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

  async respondToMessage(message: UIMessage): Promise<string> {
    const result = await this.saveMessages([message]);
    if (result.status !== "completed") {
      throw new Error(`Think turn did not complete: ${result.status}`);
    }

    const text = extractLatestAssistantText(await this.getMessages());
    if (!text) {
      throw new Error("Think completed without a text assistant response");
    }

    return text;
  }

  async resetConversation(): Promise<void> {
    await this.clearMessages();
  }
}
