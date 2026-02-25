import { Agent } from "../../index";
import {
  AgentSessionProvider,
  type AIMessage
} from "../../experimental/memory/session";

/**
 * Test Agent for session memory tests
 */
export class TestSessionAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  // Session provider instance
  session = new AgentSessionProvider(this);

  // ── Test helper methods (callable via DO RPC) ──────────────────────

  getMessages(): AIMessage[] {
    return this.session.getMessages();
  }

  getMessagesWithOptions(options: {
    limit?: number;
    offset?: number;
    role?: "user" | "assistant" | "system";
  }): AIMessage[] {
    return this.session.getMessages(options);
  }

  appendMessage(message: AIMessage): void {
    this.session.append(message);
  }

  appendMessages(messages: AIMessage[]): void {
    this.session.append(messages);
  }

  updateMessage(message: AIMessage): void {
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

  getMessage(id: string): AIMessage | null {
    return this.session.getMessage(id);
  }

  getLastMessages(n: number): AIMessage[] {
    return this.session.getLastMessages(n);
  }
}
