import { ThinkUpgradeTestAgent } from "./prompt-cache";

/**
 * An agent upgraded over the prompt think@0.24.0 froze: the row its
 * `_system_prompt` context provider wrote, and the turn it answered with it.
 */
export class ThinkUpgradeFrozenPromptAgent extends ThinkUpgradeTestAgent {
  /**
   * Leave what the release left: a turn it answered, and its frozen prompt in
   * `cf_agents_context_blocks` under `_system_prompt` (with the session id
   * when there is one), the table and row shape its `AgentContextProvider`
   * wrote.
   */
  async leaveReleasedFrozenPromptForTest(frozen: string): Promise<void> {
    await this.addMessages([
      {
        id: "r0",
        role: "user",
        parts: [{ type: "text", text: "before the upgrade" }]
      }
    ]);
    await this.addMessages(
      [{ id: "r1", role: "assistant", parts: [{ type: "text", text: "ok" }] }],
      { parentId: "r0" }
    );
    const sessionId = this.session.sessionId;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_context_blocks (
        label TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.ctx.storage.sql.exec(
      `INSERT INTO cf_agents_context_blocks (label, content) VALUES (?, ?)
       ON CONFLICT(label) DO UPDATE SET content = excluded.content`,
      sessionId ? `_system_prompt_${sessionId}` : "_system_prompt",
      frozen
    );
  }

  /** End this isolate, as an eviction or a deploy does. */
  resetIsolateForTest(): void {
    this.ctx.abort("test reset");
  }

  /**
   * Ask `text` (after clearing the transcript when `clearFirst`) and return
   * the system prompt of the turn's first model request.
   */
  async systemOfNextTurnForTest(
    text: string,
    clearFirst = false
  ): Promise<string | undefined> {
    if (clearFirst) await this.clearMessages();
    const before = this.requestCountForTest();
    await this.saveMessages([
      {
        id: `u-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text }]
      }
    ]);
    const first = this.requestForTest(before)[0] as
      | { role?: string; content?: unknown }
      | undefined;
    return first?.role === "system" ? String(first.content) : undefined;
  }
}
