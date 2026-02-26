import type { UIMessage } from "ai";
import { Agent } from "../../index";
import {
  Session,
  AgentSessionProvider,
  type CompactResult
} from "../../experimental/memory/session";

/**
 * Test Agent for session memory tests (default config, microCompact enabled)
 */
export class TestSessionAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  // Session wrapper (default: microCompact enabled)
  session = new Session(new AgentSessionProvider(this));

  // ── Test helper methods (callable via DO RPC) ──────────────────────

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
}

/**
 * Test Agent with microCompact disabled
 */
export class TestSessionAgentNoMicroCompaction extends Agent<
  Record<string, unknown>
> {
  observability = undefined;

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
 * Test Agent with custom microCompact rules
 */
export class TestSessionAgentCustomRules extends Agent<
  Record<string, unknown>
> {
  observability = undefined;

  session = new Session(new AgentSessionProvider(this), {
    microCompaction: {
      truncateToolOutputs: 100, // Very low threshold for testing
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
