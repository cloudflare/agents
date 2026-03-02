import type { UIMessage } from "ai";
import { Agent, callable } from "../../index.ts";
import { SessionManager } from "../../experimental/assistant/session/index.ts";
import type {
  Session,
  Compaction
} from "../../experimental/assistant/session/index.ts";

export class TestAssistantSessionAgent extends Agent<Record<string, unknown>> {
  private _sessions = new SessionManager(this);

  // ── Session lifecycle ──────────────────────────────────────────

  @callable()
  async createSession(name: string): Promise<Session> {
    return this._sessions.create(name);
  }

  @callable()
  async getSession(sessionId: string): Promise<Session | null> {
    return this._sessions.get(sessionId);
  }

  @callable()
  async listSessions(): Promise<Session[]> {
    return this._sessions.list();
  }

  @callable()
  async deleteSession(sessionId: string): Promise<void> {
    this._sessions.delete(sessionId);
  }

  @callable()
  async renameSession(sessionId: string, name: string): Promise<void> {
    this._sessions.rename(sessionId, name);
  }

  // ── Messages ───────────────────────────────────────────────────

  @callable()
  async appendMessage(
    sessionId: string,
    message: UIMessage,
    parentId?: string
  ): Promise<string> {
    return this._sessions.append(sessionId, message, parentId);
  }

  @callable()
  async appendAllMessages(
    sessionId: string,
    messages: UIMessage[]
  ): Promise<string | null> {
    return this._sessions.appendAll(sessionId, messages);
  }

  @callable()
  async getHistory(sessionId: string, leafId?: string): Promise<UIMessage[]> {
    return this._sessions.getHistory(sessionId, leafId);
  }

  @callable()
  async getMessageCount(sessionId: string): Promise<number> {
    return this._sessions.getMessageCount(sessionId);
  }

  @callable()
  async needsCompaction(sessionId: string): Promise<boolean> {
    return this._sessions.needsCompaction(sessionId);
  }

  // ── Branching ──────────────────────────────────────────────────

  @callable()
  async getBranches(messageId: string): Promise<UIMessage[]> {
    return this._sessions.getBranches(messageId);
  }

  @callable()
  async forkSession(
    _sessionId: string,
    atMessageId: string,
    newName: string
  ): Promise<Session> {
    return this._sessions.fork(atMessageId, newName);
  }

  // ── Compaction ─────────────────────────────────────────────────

  @callable()
  async addCompaction(
    sessionId: string,
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): Promise<Compaction> {
    return this._sessions.addCompaction(
      sessionId,
      summary,
      fromMessageId,
      toMessageId
    );
  }

  @callable()
  async getCompactions(sessionId: string): Promise<Compaction[]> {
    return this._sessions.getCompactions(sessionId);
  }
}
