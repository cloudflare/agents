/**
 * Test agent for AssistantAgent integration tests.
 *
 * Extends AssistantAgent and overrides onChatMessage to return a
 * simple streaming response. Also exposes additional callable
 * methods for test introspection.
 */

import { callable } from "../../index";
import { AssistantAgent } from "../../experimental/assistant/agent";
import type { ChatMessageOptions } from "../../experimental/assistant/agent";
import type { Session } from "../../experimental/assistant/session/index";
import type { UIMessage } from "ai";

export class TestAssistantAgentAgent extends AssistantAgent {
  /**
   * Simple onChatMessage that returns a streaming SSE response
   * containing a single text part.
   */
  async onChatMessage(
    _options?: ChatMessageOptions
  ): Promise<Response | undefined> {
    // Build a minimal AI SDK v5 SSE response with a text message
    const messageId = crypto.randomUUID();
    const events = [
      `data: ${JSON.stringify({ type: "start", messageId })}\n\n`,
      `data: ${JSON.stringify({ type: "text-start", id: "t1" })}\n\n`,
      `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "Hello " })}\n\n`,
      `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "from " })}\n\n`,
      `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "assistant" })}\n\n`,
      `data: ${JSON.stringify({ type: "text-end", id: "t1" })}\n\n`,
      `data: ${JSON.stringify({ type: "finish", messageMetadata: {} })}\n\n`
    ];

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      }
    });

    return new Response(stream, {
      headers: { "content-type": "text/event-stream" }
    });
  }

  // ── Test introspection methods ──────────────────────────────────

  @callable()
  getMessages(): UIMessage[] {
    return this.messages;
  }

  @callable()
  getSessionHistory(sessionId: string): UIMessage[] {
    return this.sessions.getHistory(sessionId);
  }

  @callable()
  getSessionCount(): number {
    return this.sessions.list().length;
  }

  @callable()
  clearCurrentSessionMessages(): void {
    if (this.getCurrentSessionId()) {
      this.sessions.clearMessages(this.getCurrentSessionId()!);
      this.messages = [];
    }
  }

  @callable()
  override getSessions(): Session[] {
    return super.getSessions();
  }

  @callable()
  override createSession(name: string): Session {
    return super.createSession(name);
  }

  @callable()
  override switchSession(sessionId: string): UIMessage[] {
    return super.switchSession(sessionId);
  }

  @callable()
  override deleteSession(sessionId: string): void {
    return super.deleteSession(sessionId);
  }

  @callable()
  override renameSession(sessionId: string, name: string): void {
    return super.renameSession(sessionId, name);
  }

  @callable()
  override getCurrentSessionId(): string | null {
    return super.getCurrentSessionId();
  }
}
