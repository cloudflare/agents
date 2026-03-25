import type { UIMessage } from "ai";
import { Agent } from "../../index";
import {
  Session,
  AgentSessionProvider,
  type StoredCompaction,
  type ContextBlock
} from "../../experimental/memory/session";

/**
 * Test Agent — full Session API
 */
export class TestSessionAgent extends Agent {
  session = new Session(new AgentSessionProvider(this));

  // ── Messages ────────────────────────────────────────────────────

  async appendMessage(message: UIMessage, parentId?: string): Promise<void> {
    await this.session.appendMessage(message, parentId);
  }

  async getMessage(id: string): Promise<UIMessage | null> {
    return this.session.getMessage(id);
  }

  async updateMessage(message: UIMessage): Promise<void> {
    await this.session.updateMessage(message);
  }

  async deleteMessages(ids: string[]): Promise<void> {
    await this.session.deleteMessages(ids);
  }

  async clearMessages(): Promise<void> {
    await this.session.clearMessages();
  }

  // ── History (tree) ──────────────────────────────────────────────

  async getHistory(leafId?: string): Promise<UIMessage[]> {
    return this.session.getHistory(leafId);
  }

  async getLatestLeaf(): Promise<UIMessage | null> {
    return this.session.getLatestLeaf();
  }

  async getBranches(messageId: string): Promise<UIMessage[]> {
    return this.session.getBranches(messageId);
  }

  async getPathLength(): Promise<number> {
    return this.session.getPathLength();
  }

  // ── Compaction ──────────────────────────────────────────────────

  async addCompaction(
    summary: string,
    fromId: string,
    toId: string
  ): Promise<StoredCompaction> {
    return this.session.addCompaction(summary, fromId, toId);
  }

  async getCompactions(): Promise<StoredCompaction[]> {
    return this.session.getCompactions();
  }

  async needsCompaction(max?: number): Promise<boolean> {
    return this.session.needsCompaction(max);
  }

  // ── Search ──────────────────────────────────────────────────────

  async search(
    query: string
  ): Promise<Array<{ id: string; role: string; content: string }>> {
    return this.session.search(query);
  }
}

/**
 * Test Agent — context blocks with frozen snapshot
 */
export class TestSessionAgentWithContext extends Agent<Cloudflare.Env> {
  session = new Session(new AgentSessionProvider(this), {
    context: [
      { label: "memory", description: "Persistent notes", maxTokens: 500 },
      {
        label: "soul",
        description: "Identity",
        initialContent: "You are helpful.",
        readonly: true
      }
    ]
  });

  async freezeSystemPrompt(): Promise<string> {
    return this.session.freezeSystemPrompt();
  }

  async refreshSystemPrompt(): Promise<string> {
    return this.session.refreshSystemPrompt();
  }

  async setBlock(label: string, content: string): Promise<ContextBlock> {
    return this.session.replaceContextBlock(label, content);
  }

  getBlock(label: string): ContextBlock | null {
    return this.session.getContextBlock(label);
  }

  getBlocks(): ContextBlock[] {
    return this.session.getContextBlocks();
  }

  async getTools(): Promise<Record<string, unknown>> {
    return this.session.tools();
  }
}
