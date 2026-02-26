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

/**
 * Context provider that wraps an Agent's SQLite storage.
 * Provides pure CRUD — validation is handled by the Context wrapper.
 *
 * @example
 * ```typescript
 * import { Context, AgentContextProvider } from "agents/experimental/memory/context";
 *
 * // In your Agent class:
 * context = new Context(new AgentContextProvider(this), {
 *   blocks: [
 *     { label: "soul", description: "Agent personality", defaultContent: "helpful", readonly: true },
 *     { label: "todos", description: "User's todo list", maxTokens: 5000 }
 *   ]
 * });
 * ```
 */
export class AgentContextProvider implements ContextProvider {
  private agent: SqlProvider;
  private initialized = false;

  constructor(agent: SqlProvider) {
    this.agent = agent;
  }

  /**
   * Ensure the context blocks table exists
   */
  private ensureTable(): void {
    if (this.initialized) return;

    this.agent.sql`
			CREATE TABLE IF NOT EXISTS cf_agents_context_blocks (
				label TEXT PRIMARY KEY,
				content TEXT NOT NULL DEFAULT '',
				description TEXT,
				max_tokens INTEGER,
				readonly INTEGER DEFAULT 0,
				updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
			)
		`;
    this.initialized = true;
  }

  /**
   * Get all blocks.
   */
  getBlocks(): Record<string, StoredBlock> {
    this.ensureTable();

    type Row = {
      label: string;
      content: string;
      description: string | null;
      max_tokens: number | null;
      readonly: number;
    };

    const rows = this.agent.sql<Row>`
			SELECT label, content, description, max_tokens, readonly
			FROM cf_agents_context_blocks
			ORDER BY label ASC
		`;

    const result: Record<string, StoredBlock> = {};
    for (const row of rows) {
      result[row.label] = this.rowToBlock(row);
    }
    return result;
  }

  /**
   * Get a single block by label.
   */
  getBlock(label: string): StoredBlock | null {
    this.ensureTable();

    type Row = {
      label: string;
      content: string;
      description: string | null;
      max_tokens: number | null;
      readonly: number;
    };

    const rows = this.agent.sql<Row>`
			SELECT label, content, description, max_tokens, readonly
			FROM cf_agents_context_blocks
			WHERE label = ${label}
		`;

    if (rows.length === 0) return null;
    return this.rowToBlock(rows[0]);
  }

  /**
   * Set (upsert) a block.
   */
  setBlock(label: string, content: string, metadata?: BlockMetadata): void {
    this.ensureTable();

    const description = metadata?.description ?? null;
    const maxTokens = metadata?.maxTokens ?? null;
    const readonly = metadata?.readonly ? 1 : 0;
    const now = new Date().toISOString();

    this.agent.sql`
			INSERT INTO cf_agents_context_blocks (label, content, description, max_tokens, readonly, updated_at)
			VALUES (${label}, ${content}, ${description}, ${maxTokens}, ${readonly}, ${now})
			ON CONFLICT(label) DO UPDATE SET
				content = excluded.content,
				description = excluded.description,
				max_tokens = excluded.max_tokens,
				readonly = excluded.readonly,
				updated_at = excluded.updated_at
		`;
  }

  /**
   * Delete a block by label.
   */
  deleteBlock(label: string): void {
    this.ensureTable();

    this.agent.sql`
			DELETE FROM cf_agents_context_blocks WHERE label = ${label}
		`;
  }

  /**
   * Clear all blocks.
   */
  clearBlocks(): void {
    this.ensureTable();

    this.agent.sql`DELETE FROM cf_agents_context_blocks`;
  }

  /**
   * Convert a SQL row to a StoredBlock.
   */
  private rowToBlock(row: {
    label: string;
    content: string;
    description: string | null;
    max_tokens: number | null;
    readonly: number;
  }): StoredBlock {
    const block: StoredBlock = {
      label: row.label,
      content: row.content
    };
    if (row.description !== null) block.description = row.description;
    if (row.max_tokens !== null) block.maxTokens = row.max_tokens;
    if (row.readonly === 1) block.readonly = true;
    return block;
  }
}
