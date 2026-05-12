import { getCurrentAgent, type Agent } from "agents";
import type {
  BrowserSessionInfo,
  BrowserSessionStore,
  BrowserToolsOptions,
  StoredBrowserSession
} from "agents/browser";

export type ThinkBrowserToolsOptions = BrowserToolsOptions;

class ThinkBrowserSessionStore implements BrowserSessionStore {
  #ready = false;

  constructor(private readonly agent: Agent) {}

  get(key: string): StoredBrowserSession | undefined {
    this.#ensureTable();
    const rows = this.agent.sql<{
      browser_session_id: string;
      created_at: number;
      updated_at: number;
    }>`
      SELECT browser_session_id, created_at, updated_at
      FROM think_browser_sessions
      WHERE key = ${key}
    `;
    const row = rows[0];
    if (!row) return undefined;
    return {
      sessionId: row.browser_session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  set(key: string, session: StoredBrowserSession): void {
    this.#ensureTable();
    this.agent.sql`
      INSERT OR REPLACE INTO think_browser_sessions
        (key, browser_session_id, created_at, updated_at)
      VALUES (${key}, ${session.sessionId}, ${session.createdAt}, ${session.updatedAt})
    `;
  }

  delete(key: string): void {
    this.#ensureTable();
    this.agent.sql`
      DELETE FROM think_browser_sessions
      WHERE key = ${key}
    `;
  }

  #ensureTable(): void {
    if (this.#ready) return;
    this.agent.sql`
      CREATE TABLE IF NOT EXISTS think_browser_sessions (
        key TEXT NOT NULL PRIMARY KEY,
        browser_session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.#ready = true;
  }
}

export function withThinkSessionDefaults(
  options: ThinkBrowserToolsOptions
): BrowserToolsOptions {
  if (options.session?.mode !== "reuse") {
    return options;
  }

  const { agent } = getCurrentAgent<Agent>();
  if (!agent) {
    return options;
  }

  const userOnSessionInfo = options.session.onSessionInfo;
  return {
    ...options,
    session: {
      ...options.session,
      key: options.session.key ?? `think:${agent.sessionAffinity}:default`,
      store: options.session.store ?? new ThinkBrowserSessionStore(agent),
      onSessionInfo: async (info: BrowserSessionInfo) => {
        agent.broadcast(
          JSON.stringify({
            type: "browser-session",
            session: info
          })
        );
        await userOnSessionInfo?.(info);
      }
    }
  };
}
