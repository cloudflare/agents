/**
 * SQLite Context Block Provider
 *
 * Default durable storage for context blocks using DO SQLite.
 * Each block is a row in cf_agents_context_blocks.
 */

import type { ContextBlockProvider } from "../context";

export interface SqlProvider {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

export class AgentContextProvider implements ContextBlockProvider {
  private agent: SqlProvider;
  private label: string;
  private initialized = false;

  constructor(agent: SqlProvider, label: string) {
    this.agent = agent;
    this.label = label;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.agent.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_context_blocks (
        label TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this.initialized = true;
  }

  async get(): Promise<string | null> {
    this.ensureTable();
    const rows = this.agent.sql<{ content: string }>`
      SELECT content FROM cf_agents_context_blocks WHERE label = ${this.label}
    `;
    return rows[0]?.content ?? null;
  }

  async set(content: string): Promise<void> {
    this.ensureTable();
    this.agent.sql`
      INSERT INTO cf_agents_context_blocks (label, content)
      VALUES (${this.label}, ${content})
      ON CONFLICT(label) DO UPDATE SET content = ${content}, updated_at = CURRENT_TIMESTAMP
    `;
  }
}
