import type { UIMessage } from "ai";
import { Agent } from "../../index";
import {
  Session,
  AgentSessionProvider,
  type CompactResult,
  type StoredCompaction,
  type ContextBlock,
} from "../../experimental/memory/session";

/**
 * Test Agent — default config (microCompact enabled)
 */
export class TestSessionAgent extends Agent {
  session = new Session(new AgentSessionProvider(this));

  // ── Messages ────────────────────────────────────────────────────

  getMessages(): UIMessage[] {
    return this.session.getMessages();
  }

  getMessagesWithOptions(options: {
    limit?: number;
    offset?: number;
    role?: "user" | "assistant" | "system";
  }): UIMessage[] {
    return this.session.getMessages(options);
  }

  async appendMessage(message: UIMessage): Promise<void> {
    await this.session.append(message);
  }

  async appendMessages(messages: UIMessage[]): Promise<void> {
    await this.session.append(messages);
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

  getMessage(id: string): UIMessage | null {
    return this.session.getMessage(id);
  }

  getLastMessages(n: number): UIMessage[] {
    return this.session.getLastMessages(n);
  }

  async compact(): Promise<CompactResult> {
    return this.session.compact();
  }

  // ── Branching ────────────────────────────────────────────────────

  appendMessageWithParent(message: UIMessage, parentId: string): void {
    this.session.appendMessage(message, parentId);
  }

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

  // ── Compaction records ──────────────────────────────────────────

  addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): StoredCompaction {
    return this.session.addCompaction(summary, fromMessageId, toMessageId);
  }

  getCompactions(): StoredCompaction[] {
    return this.session.getCompactions();
  }

  needsCompaction(maxMessages?: number): boolean {
    return this.session.needsCompaction(maxMessages);
  }

  // ── Search ──────────────────────────────────────────────────────

  search(query: string): Array<{ id: string; role: string; content: string }> {
    return this.session.search(query);
  }
}

/**
 * Test Agent — microCompact disabled
 */
export class TestSessionAgentNoMicroCompaction extends Agent<Cloudflare.Env> {
  session = new Session(new AgentSessionProvider(this), {
    microCompaction: false
  });

  getMessages(): UIMessage[] {
    return this.session.getMessages();
  }

  async appendMessage(message: UIMessage): Promise<void> {
    await this.session.append(message);
  }

  async appendMessages(messages: UIMessage[]): Promise<void> {
    await this.session.append(messages);
  }

  clearMessages(): void {
    this.session.clearMessages();
  }

  async compact(): Promise<CompactResult> {
    return this.session.compact();
  }
}

/**
 * Test Agent — custom microCompact rules
 */
export class TestSessionAgentCustomRules extends Agent<Cloudflare.Env> {
  session = new Session(new AgentSessionProvider(this), {
    microCompaction: {
      truncateToolOutputs: 100,
      truncateText: 200,
      keepRecent: 2
    }
  });

  getMessages(): UIMessage[] {
    return this.session.getMessages();
  }

  async appendMessage(message: UIMessage): Promise<void> {
    await this.session.append(message);
  }

  async appendMessages(messages: UIMessage[]): Promise<void> {
    await this.session.append(messages);
  }

  clearMessages(): void {
    this.session.clearMessages();
  }

  async compact(): Promise<CompactResult> {
    return this.session.compact();
  }
}

/**
 * Test Agent — context blocks with frozen snapshot
 */
export class TestSessionAgentWithContext extends Agent<Cloudflare.Env> {
  session = new Session(new AgentSessionProvider(this), {
    context: [
      { label: "memory", description: "Persistent notes", maxTokens: 500 },
      { label: "soul", description: "Identity", defaultContent: "You are helpful.", readonly: true },
    ]
  });

  async initSession(): Promise<void> {
    await this.session.init();
  }

  toSystemPrompt(): string {
    return this.session.toSystemPrompt();
  }

  refreshSystemPrompt(): string {
    return this.session.refreshSystemPrompt();
  }

  async setBlock(label: string, content: string): Promise<ContextBlock> {
    return this.session.setBlock(label, content);
  }

  getBlock(label: string): ContextBlock | null {
    return this.session.getBlock(label);
  }

  getBlocks(): ContextBlock[] {
    return this.session.getBlocks();
  }

  getTools(): Record<string, unknown> {
    return this.session.tools();
  }
}
