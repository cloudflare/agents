import { Agent } from "../../index";
import {
  AgentSessionProvider,
  type UIMessage
} from "../../experimental/memory/session";

/**
 * Test Agent for session memory tests
 */
export class TestSessionAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  // Session provider instance
  session = new AgentSessionProvider(this);

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
    this.session.update(message);
  }

  deleteMessages(ids: string[]): void {
    this.session.delete(ids);
  }

  clearMessages(): void {
    this.session.clear();
  }

  countMessages(): number {
    return this.session.count();
  }

  getMessage(id: string): UIMessage | null {
    return this.session.getMessage(id);
  }

  getLastMessages(n: number): UIMessage[] {
    return this.session.getLastMessages(n);
  }
}
