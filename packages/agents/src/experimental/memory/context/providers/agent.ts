/**
 * Agent Context Provider
 *
 * Pure storage provider that uses the Agent's DO SQLite storage.
 * Business logic (readonly, maxTokens) is handled by the Context wrapper.
 */

import type { ContextProvider } from "../provider";
import type { StoredBlock, BlockMetadata } from "../types";

/**
 * Interface for objects that provide a sql tagged template method.
 * This matches the Agent class's sql method signature.
 */
export interface SqlProvider {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

export class AgentContextProvider implements ContextProvider {
  private agent: SqlProvider;
  private initialized = false;

  constructor(agent: SqlProvider) {
    this.agent = agent;
  }

  private ensureTable(): void {
    if (this.initialized) return;

    this.agent.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_context_blocks (
        label TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        description TEXT,
        max_tokens INTEGER,
        readonly INTEGER DEFAULT 0,
        source TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // Migration: add source column for existing tables
    try {
      this.agent.sql`ALTER TABLE cf_agents_context_blocks ADD COLUMN source TEXT`;
    } catch {
      // Column already exists
    }

    this.initialized = true;
  }

  getBlocks(): Record<string, StoredBlock> {
    this.ensureTable();

    type Row = {
      label: string;
      content: string;
      description: string | null;
      max_tokens: number | null;
      readonly: number;
      source: string | null;
      updated_at: string;
    };

    const rows = this.agent.sql<Row>`
      SELECT label, content, description, max_tokens, readonly, source, updated_at
      FROM cf_agents_context_blocks
      ORDER BY label ASC
    `;

    const result: Record<string, StoredBlock> = {};
    for (const row of rows) {
      result[row.label] = this.rowToBlock(row);
    }
    return result;
  }

  getBlock(label: string): StoredBlock | null {
    this.ensureTable();

    type Row = {
      label: string;
      content: string;
      description: string | null;
      max_tokens: number | null;
      readonly: number;
      source: string | null;
      updated_at: string;
    };

    const rows = this.agent.sql<Row>`
      SELECT label, content, description, max_tokens, readonly, source, updated_at
      FROM cf_agents_context_blocks
      WHERE label = ${label}
    `;

    if (rows.length === 0) return null;
    return this.rowToBlock(rows[0]);
  }

  setBlock(label: string, content: string, metadata?: BlockMetadata): void {
    this.ensureTable();

    const description = metadata?.description ?? null;
    const maxTokens = metadata?.maxTokens ?? null;
    const readonly = metadata?.readonly ? 1 : 0;
    const source = metadata?.source ?? null;
    const now = new Date().toISOString();

    this.agent.sql`
      INSERT INTO cf_agents_context_blocks (label, content, description, max_tokens, readonly, source, updated_at)
      VALUES (${label}, ${content}, ${description}, ${maxTokens}, ${readonly}, ${source}, ${now})
      ON CONFLICT(label) DO UPDATE SET
        content = excluded.content,
        description = excluded.description,
        max_tokens = excluded.max_tokens,
        readonly = excluded.readonly,
        source = COALESCE(excluded.source, cf_agents_context_blocks.source),
        updated_at = excluded.updated_at
    `;
  }

  deleteBlock(label: string): void {
    this.ensureTable();
    this.agent.sql`DELETE FROM cf_agents_context_blocks WHERE label = ${label}`;
  }

  clearBlocks(): void {
    this.ensureTable();
    this.agent.sql`DELETE FROM cf_agents_context_blocks`;
  }

  private rowToBlock(row: {
    label: string;
    content: string;
    description: string | null;
    max_tokens: number | null;
    readonly: number;
    source: string | null;
    updated_at: string;
  }): StoredBlock {
    const block: StoredBlock = {
      label: row.label,
      content: row.content
    };
    if (row.description !== null) block.description = row.description;
    if (row.max_tokens !== null) block.maxTokens = row.max_tokens;
    if (row.readonly === 1) block.readonly = true;
    if (row.source !== null) block.source = row.source as StoredBlock["source"];
    if (row.updated_at) block.updatedAt = new Date(row.updated_at).getTime();
    return block;
  }
}
