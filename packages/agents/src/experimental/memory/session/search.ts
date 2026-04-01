/**
 * Search Provider — full-text searchable context blocks.
 *
 * Extends ContextProvider with `search()` for querying indexed content
 * and a keyed `set()` for indexing individual entries.
 *
 * Duck-typed: if a provider has a `search` method, it's a SearchProvider.
 */

import type { ContextProvider } from "./context";
import type { SqlProvider } from "./providers/agent";

/**
 * Storage interface for searchable context.
 *
 * - `get()` returns a summary of indexed content (rendered into system prompt)
 * - `search(query)` full-text search (via search_context tool)
 * - `set(key, content)` indexes content under a key (via set_context tool)
 */
export interface SearchProvider extends ContextProvider {
  search(query: string): Promise<string | null>;
  set?(key: string, content: string): Promise<void>;
}

/**
 * Check if a provider is a SearchProvider (has a `search` method).
 */
export function isSearchProvider(
  provider: unknown
): provider is SearchProvider {
  return (
    typeof provider === "object" &&
    provider !== null &&
    "search" in provider &&
    typeof (provider as SearchProvider).search === "function"
  );
}

// ── Agent Search Provider (DO SQLite FTS5) ─────────────────────────

/**
 * SearchProvider backed by Durable Object SQLite with FTS5.
 *
 * - `get()` returns a count of indexed entries
 * - `search(query)` full-text search using FTS5
 * - `set(key, content)` indexes or replaces content under a key
 *
 * Each instance uses a namespaced FTS5 table to avoid collisions
 * with the session message search.
 *
 * @example
 * ```ts
 * Session.create(this)
 *   .withContext("knowledge", {
 *     provider: new AgentSearchProvider(this)
 *   })
 * ```
 */
export class AgentSearchProvider implements SearchProvider {
  private agent: SqlProvider;
  private label = "";
  private initialized = false;

  constructor(agent: SqlProvider) {
    this.agent = agent;
  }

  init(label: string): void {
    this.label = label;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.agent.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_search_entries (
        label TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (label, key)
      )
    `;
    this.agent.sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS cf_agents_search_fts
      USING fts5(
        label UNINDEXED,
        key UNINDEXED,
        content,
        tokenize='porter unicode61'
      )
    `;
    this.initialized = true;
  }

  async get(): Promise<string | null> {
    this.ensureTable();
    const rows = this.agent.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_search_entries
      WHERE label = ${this.label}
    `;
    const count = rows[0]?.count ?? 0;
    if (count === 0) return null;

    const keys = this.agent.sql<{ key: string }>`
      SELECT key FROM cf_agents_search_entries
      WHERE label = ${this.label}
      ORDER BY updated_at DESC
      LIMIT 20
    `;
    const listing = keys.map((r) => `- ${r.key}`).join("\n");
    return `${count} entries indexed. Recent:\n${listing}`;
  }

  async search(query: string): Promise<string | null> {
    this.ensureTable();
    // Sanitize: wrap in double quotes to treat as literal phrase
    const sanitized = `"${query.replace(/"/g, '""')}"`;
    try {
      const rows = this.agent.sql<{
        key: string;
        content: string;
      }>`
        SELECT f.key, f.content
        FROM cf_agents_search_fts f
        WHERE cf_agents_search_fts MATCH ${sanitized}
          AND f.label = ${this.label}
        ORDER BY rank
        LIMIT 10
      `;
      if (rows.length === 0) return null;
      return rows.map((r) => `[${r.key}]\n${r.content}`).join("\n\n");
    } catch {
      // Malformed FTS query
      return null;
    }
  }

  async set(key: string, content: string): Promise<void> {
    this.ensureTable();

    // Delete old FTS entry if exists
    this.deleteFTS(key);

    // Upsert the entry
    this.agent.sql`
      INSERT INTO cf_agents_search_entries (label, key, content)
      VALUES (${this.label}, ${key}, ${content})
      ON CONFLICT(label, key) DO UPDATE SET
        content = ${content},
        updated_at = CURRENT_TIMESTAMP
    `;

    // Index in FTS
    this.agent.sql`
      INSERT INTO cf_agents_search_fts (label, key, content)
      VALUES (${this.label}, ${key}, ${content})
    `;
  }

  private deleteFTS(key: string): void {
    const rows = this.agent.sql<{ rowid: number }>`
      SELECT rowid FROM cf_agents_search_fts
      WHERE key = ${key} AND label = ${this.label}
    `;
    for (const row of rows) {
      this.agent
        .sql`DELETE FROM cf_agents_search_fts WHERE rowid = ${row.rowid}`;
    }
  }
}
