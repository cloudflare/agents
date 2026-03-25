/**
 * PlanetScale Context Block Provider
 *
 * Durable storage for context blocks using PlanetScale (MySQL/Postgres).
 */

import type { ContextProvider } from "../context";
import type { PlanetScaleConnection } from "./planetscale";

export class PlanetScaleContextProvider implements ContextProvider {
  private conn: PlanetScaleConnection;
  private label: string;
  private initialized = false;

  constructor(conn: PlanetScaleConnection, label: string) {
    this.conn = conn;
    this.label = label;
  }

  private async ensureTable(): Promise<void> {
    if (this.initialized) return;
    await this.conn.execute(`
      CREATE TABLE IF NOT EXISTS cf_agents_context_blocks (
        label VARCHAR(255) PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    this.initialized = true;
  }

  async get(): Promise<string | null> {
    await this.ensureTable();
    const { rows } = await this.conn.execute(
      "SELECT content FROM cf_agents_context_blocks WHERE label = ?",
      [this.label]
    );
    return (rows[0]?.content as string) ?? null;
  }

  async set(content: string): Promise<void> {
    await this.ensureTable();
    await this.conn.execute(
      `INSERT INTO cf_agents_context_blocks (label, content)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = CURRENT_TIMESTAMP`,
      [this.label, content]
    );
  }
}
