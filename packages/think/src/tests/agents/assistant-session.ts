import type { UIMessage } from "ai";
import { Agent } from "agents";
import { SessionManager } from "../../session/index";
import type { Session, Compaction } from "../../session/index";

export class TestAssistantSessionAgent extends Agent {
  private _sessions = new SessionManager(this);

  // ── Session lifecycle ──────────────────────────────────────────

  async createSession(name: string): Promise<Session> {
    return this._sessions.create(name);
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this._sessions.get(sessionId);
  }

  async listSessions(): Promise<Session[]> {
    return this._sessions.list();
  }

  async deleteSession(sessionId: string): Promise<void> {
    this._sessions.delete(sessionId);
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    this._sessions.rename(sessionId, name);
  }

  // ── Messages ───────────────────────────────────────────────────

  async appendMessage(
    sessionId: string,
    message: UIMessage,
    parentId?: string
  ): Promise<string> {
    return this._sessions.append(sessionId, message, parentId);
  }

  async appendAllMessages(
    sessionId: string,
    messages: UIMessage[]
  ): Promise<string | null> {
    return this._sessions.appendAll(sessionId, messages);
  }

  async getHistory(sessionId: string, leafId?: string): Promise<UIMessage[]> {
    return this._sessions.getHistory(sessionId, leafId);
  }

  async getMessageCount(sessionId: string): Promise<number> {
    return this._sessions.getMessageCount(sessionId);
  }

  async needsCompaction(sessionId: string): Promise<boolean> {
    return this._sessions.needsCompaction(sessionId);
  }

  // ── Branching ──────────────────────────────────────────────────

  async getBranches(messageId: string): Promise<UIMessage[]> {
    return this._sessions.getBranches(messageId);
  }

  async forkSession(
    _sessionId: string,
    atMessageId: string,
    newName: string
  ): Promise<Session> {
    return this._sessions.fork(atMessageId, newName);
  }

  // ── Compaction ─────────────────────────────────────────────────

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

  async getCompactions(sessionId: string): Promise<Compaction[]> {
    return this._sessions.getCompactions(sessionId);
  }
}
