/**
 * Postgres Search Provider
 *
 * Full-text searchable context blocks backed by Postgres.
 * Uses tsvector + GIN index for ranked search.
 *
 * Requires migration — see docs for the schema:
 *
 *   CREATE TABLE cf_agents_search_entries (
 *     label TEXT NOT NULL,
 *     key TEXT NOT NULL,
 *     content TEXT NOT NULL,
 *     content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
 *     created_at TIMESTAMPTZ DEFAULT NOW(),
 *     updated_at TIMESTAMPTZ DEFAULT NOW(),
 *     PRIMARY KEY (label, key)
 *   );
 *   CREATE INDEX idx_search_entries_fts ON cf_agents_search_entries USING GIN (content_tsv);
 */

import type { SearchProvider } from "../search";
import type { PostgresConnection } from "./postgres";

export class PostgresSearchProvider implements SearchProvider {
  private conn: PostgresConnection;
  private label = "";

  constructor(conn: PostgresConnection) {
    this.conn = conn;
  }

  init(label: string): void {
    this.label = label;
  }

  async get(): Promise<string | null> {
    const { rows } = await this.conn.execute(
      "SELECT COUNT(*) as count FROM cf_agents_search_entries WHERE label = ?",
      [this.label]
    );
    const count = Number(rows[0]?.count ?? 0);
    if (count === 0) return null;
    return `${count} entries indexed.`;
  }

  async search(query: string): Promise<string | null> {
    if (!query.trim()) return null;

    const { rows } = await this.conn.execute(
      `SELECT key, content FROM cf_agents_search_entries
       WHERE label = ? AND content_tsv @@ plainto_tsquery('english', ?)
       ORDER BY ts_rank(content_tsv, plainto_tsquery('english', ?)) DESC
       LIMIT 10`,
      [this.label, query, query]
    );

    if (rows.length === 0) return "No results found.";
    return rows
      .map((r) => `[${r.key as string}]\n${r.content as string}`)
      .join("\n\n");
  }

  async set(key: string, content: string): Promise<void> {
    await this.conn.execute(
      `INSERT INTO cf_agents_search_entries (label, key, content)
       VALUES (?, ?, ?)
       ON CONFLICT (label, key) DO UPDATE SET
         content = EXCLUDED.content,
         updated_at = NOW()`,
      [this.label, key, content]
    );
  }
}
