import { Agent, callable } from "agents";
import type { AgentState, Mode } from "./types";
import { createWorkersAI } from "workers-ai-provider";
import { generateText } from "ai";
import { getSummarizePrompt, getSystemPrompt } from "./prompts";

/**
 * Stateful chat agent backed by SQLite. Each Discord channel gets its own
 * agent instance (keyed by channel ID) with isolated conversation history.
 *
 * Methods marked @callable are available via Cloudflare RPC from the Worker
 * and via WebSocket RPC from a future React frontend.
 */
export class ChatAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { initialized: false, totalMessages: 0 };

  async onStart(): Promise<void> {
    this.sql`
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				thread_id TEXT NOT NULL,
				role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
				content TEXT NOT NULL,
				user_id TEXT,
				user_name TEXT,
				created_at INTEGER DEFAULT (unixepoch())
			)
		`;

    this.sql`
			CREATE INDEX IF NOT EXISTS idx_messages_thread
			ON messages(thread_id, created_at)
		`;

    if (!this.state.initialized) {
      this.setState({ ...this.state, initialized: true });
    }
  }

  private getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/zai-org/glm-4.7-flash"
    );
  }

  private getHistory(threadId: string, limit: number = 20) {
    const rows = this.sql<{ role: "user" | "assistant"; content: string }>`
			SELECT role, content FROM messages
			WHERE thread_id = ${threadId}
			ORDER BY created_at DESC
			LIMIT ${limit}
		`;
    return [...rows].reverse();
  }

  private saveMessage(
    threadId: string,
    role: "user" | "assistant",
    content: string,
    userId?: string,
    userName?: string
  ): void {
    this.sql`
			INSERT INTO messages (thread_id, role, content, user_id, user_name)
			VALUES (${threadId}, ${role}, ${content}, ${userId ?? null}, ${userName ?? null})
		`;
  }

  @callable()
  async ask(
    text: string,
    threadId: string,
    userId: string,
    userName: string,
    mode: Mode
  ): Promise<string> {
    const history = this.getHistory(threadId);
    this.saveMessage(threadId, "user", text, userId, userName);

    const result = await generateText({
      model: this.getModel(),
      system: getSystemPrompt(mode),
      messages: [...history, { role: "user" as const, content: text }]
    });

    this.saveMessage(threadId, "assistant", result.text);
    this.setState({
      ...this.state,
      totalMessages: this.state.totalMessages + 1
    });

    return result.text;
  }

  @callable()
  async summarize(
    threadId: string
  ): Promise<{ text: string; messageCount: number; participantCount: number }> {
    const history = this.getHistory(threadId, 50);

    if (history.length === 0) {
      return {
        text: "No conversation history to summarize",
        messageCount: 0,
        participantCount: 0
      };
    }

    const formatted = history
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join("\n");

    const result = await generateText({
      model: this.getModel(),
      system: getSummarizePrompt(),
      messages: [{ role: "user", content: formatted }]
    });

    const participants = this.sql<{ cnt: number }>`
			SELECT COUNT(DISTINCT user_id) as cnt
			FROM messages
			WHERE thread_id = ${threadId} AND user_id IS NOT NULL
		`;
    const participantCount = [...participants][0]?.cnt ?? 0;

    return {
      text: result.text,
      messageCount: history.length,
      participantCount
    };
  }
}
