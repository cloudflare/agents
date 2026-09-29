/**
 * Search Provider — full-text searchable context blocks.
 *
 * Extends ContextProvider with `search()` for querying indexed content
 * and a keyed `set()` for indexing individual entries.
 *
 * Duck-typed: if a provider has a `search` method, it's a SearchProvider.
 */

import type { ContextProvider } from "./blocks";
import type { SqlProvider } from "./sqlite-provider";

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
 * Entries live in one namespaced FTS5 table, separate from the session
 * message index.
 *
 * @example
 * ```ts
 * const context = new ContextBlocks([
 *   { label: "knowledge", provider: new AgentSearchProvider(this) }
 * ]);
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
    // The FTS table is the only store: a mirror row table would double the
    // billed writes of every indexed entry to serve a count and a lookup the
    // index already answers.
    this.agent.sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS cf_agents_search_fts
      USING fts5(
        label UNINDEXED,
        key UNINDEXED,
        content,
        tokenize='porter unicode61'
      )
    `;
    this.agent.sql`DROP TABLE IF EXISTS cf_agents_search_entries`;
    this.initialized = true;
  }

  async get(): Promise<string | null> {
    this.ensureTable();
    const rows = this.agent.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_search_fts
      WHERE label = ${this.label}
    `;
    const count = rows[0]?.count ?? 0;
    if (count === 0) return null;
    return `${count} entries indexed.`;
  }

  async search(query: string): Promise<string | null> {
    this.ensureTable();
    // Quote each word individually to prevent FTS5 syntax injection
    // while preserving implicit AND between terms
    const sanitized = query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(" ");
    if (!sanitized) return null;
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
    this.agent.sql`
      DELETE FROM cf_agents_search_fts
      WHERE label = ${this.label} AND key = ${key}
    `;
    this.agent.sql`
      INSERT INTO cf_agents_search_fts (label, key, content)
      VALUES (${this.label}, ${key}, ${content})
    `;
  }
}
