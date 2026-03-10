/**
 * Test agent for Think integration tests (WebSocket protocol).
 *
 * Extends Think and overrides onChatMessage to return a
 * simple streaming response. Also exposes additional callable
 * methods for test introspection.
 */

import { Think } from "../../think";
import type { ChatMessageOptions, StreamableResult } from "../../think";
import type { Session } from "../../session/index";
import type { UIMessage } from "ai";

export class TestAssistantAgentAgent extends Think {
  /**
   * Simple onChatMessage that returns a StreamableResult
   * producing a single text part.
   */
  async onChatMessage(
    _options?: ChatMessageOptions
  ): Promise<StreamableResult> {
    const chunks = [
      { type: "start", messageId: crypto.randomUUID() },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hello " },
      { type: "text-delta", id: "t1", delta: "from " },
      { type: "text-delta", id: "t1", delta: "assistant" },
      { type: "text-end", id: "t1" },
      { type: "finish", messageMetadata: {} }
    ];

    return {
      toUIMessageStream() {
        return (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })();
      }
    };
  }

  // ── Test introspection methods ──────────────────────────────────

  getMessages(): UIMessage[] {
    return this.messages;
  }

  getSessionHistory(sessionId: string): UIMessage[] {
    return this.sessions.getHistory(sessionId);
  }

  getSessionCount(): number {
    return this.sessions.list().length;
  }

  clearCurrentSessionMessages(): void {
    if (this.getCurrentSessionId()) {
      this.sessions.clearMessages(this.getCurrentSessionId()!);
      this.messages = [];
    }
  }

  override getSessions(): Session[] {
    return super.getSessions();
  }

  override createSession(name: string): Session {
    return super.createSession(name);
  }

  override switchSession(sessionId: string): UIMessage[] {
    return super.switchSession(sessionId);
  }

  override deleteSession(sessionId: string): void {
    return super.deleteSession(sessionId);
  }

  override renameSession(sessionId: string, name: string): void {
    return super.renameSession(sessionId, name);
  }

  override getCurrentSessionId(): string | null {
    return super.getCurrentSessionId();
  }

  trySwitchSession(
    sessionId: string
  ): { error: string } | { messages: UIMessage[] } {
    try {
      const messages = super.switchSession(sessionId);
      return { messages };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  tryDeleteSession(sessionId: string): { error: string } | { ok: true } {
    try {
      super.deleteSession(sessionId);
      return { ok: true };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  tryRenameSession(
    sessionId: string,
    name: string
  ): { error: string } | { ok: true } {
    try {
      super.renameSession(sessionId, name);
      return { ok: true };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
}
