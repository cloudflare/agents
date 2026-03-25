/**
 * Postgres Context Block Provider
 *
 * Durable storage for context blocks using Postgres.
 * Table must be created by the customer via migration — see docs for the schema.
 */

import type { WritableContextProvider } from "../context";
import type { PostgresConnection } from "./postgres";

export class PostgresContextProvider implements WritableContextProvider {
  private conn: PostgresConnection;
  private label: string;

  constructor(conn: PostgresConnection, label: string) {
    this.conn = conn;
    this.label = label;
  }

  async get(): Promise<string | null> {
    const { rows } = await this.conn.execute(
      "SELECT content FROM cf_agents_context_blocks WHERE label = ?",
      [this.label]
    );
    return (rows[0]?.content as string) ?? null;
  }

  async set(content: string): Promise<void> {
    await this.conn.execute(
      `INSERT INTO cf_agents_context_blocks (label, content)
       VALUES (?, ?)
       ON CONFLICT (label) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
      [this.label, content]
    );
  }
}
