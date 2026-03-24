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

  appendMessage(message: UIMessage, parentId?: string): void {
    this.session.appendMessage(message, parentId);
  }

  getMessage(id: string): UIMessage | null {
    return this.session.getMessage(id);
  }

  updateMessage(message: UIMessage): void {
    this.session.updateMessage(message);
  }

  deleteMessages(ids: string[]): void {
    this.session.deleteMessages(ids);
  }

  clearMessages(): void {
    this.session.clearMessages();
  }

  // ── History (tree) ──────────────────────────────────────────────

  getHistory(leafId?: string): UIMessage[] {
    return this.session.getHistory(leafId);
  }

  getLatestLeaf(): UIMessage | null {
    return this.session.getLatestLeaf();
  }

  getBranches(messageId: string): UIMessage[] {
    return this.session.getBranches(messageId);
  }

  getPathLength(): number {
    return this.session.getPathLength();
  }

  // ── Compaction ──────────────────────────────────────────────────

  addCompaction(
    summary: string,
    fromId: string,
    toId: string
  ): StoredCompaction {
    return this.session.addCompaction(summary, fromId, toId);
  }

  getCompactions(): StoredCompaction[] {
    return this.session.getCompactions();
  }

  needsCompaction(max?: number): boolean {
    return this.session.needsCompaction(max);
  }

  // ── Search ──────────────────────────────────────────────────────

  search(query: string): Array<{ id: string; role: string; content: string }> {
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
