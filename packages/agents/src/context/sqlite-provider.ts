/**
 * SQLite Context Block Provider
 *
 * Default durable storage for context blocks using DO SQLite.
 * Each block is a row in cf_agents_context_blocks.
 */

import type { WritableContextProvider } from "./blocks";

/** Minimal tagged-template SQL surface used by SQLite context providers. */
export interface SqlProvider {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

/** SQLite-backed writable context block provider. */
export class AgentContextProvider implements WritableContextProvider {
  private agent: SqlProvider;
  private label: string;
  private initialized = false;
  readonly #table: string;

  /**
   * @param table @internal The block table: Context passes the one of the
   *   Sessions instance it was given. Default `cf_agents_context_blocks`.
   */
  constructor(
    agent: SqlProvider,
    label?: string,
    table = "cf_agents_context_blocks"
  ) {
    this.agent = agent;
    this.label = label ?? "";
    this.#table = table;
  }

  init(label: string): void {
    if (!this.label) {
      this.label = label;
    }
  }

  /**
   * Run `parts` as a tagged template whose text holds the table name. The
   * name is fixed at construction, never a value; values stay bound.
   */
  #sql<T>(
    parts: string[],
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const strings = Object.assign([...parts], { raw: [...parts] });
    // SAFETY: an array with `raw` is what a tagged template receives.
    return this.agent.sql<T>(
      strings as unknown as TemplateStringsArray,
      ...values
    );
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.#sql([
      `CREATE TABLE IF NOT EXISTS ${this.#table} (
        label TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ]);
    this.initialized = true;
  }

  async get(): Promise<string | null> {
    this.ensureTable();
    const rows = this.#sql<{ content: string }>(
      [`SELECT content FROM ${this.#table} WHERE label = `, ""],
      this.label
    );
    return rows[0]?.content ?? null;
  }

  async set(content: string): Promise<void> {
    this.ensureTable();
    this.#sql(
      [
        `INSERT INTO ${this.#table} (label, content) VALUES (`,
        ", ",
        `) ON CONFLICT(label) DO UPDATE SET content = `,
        ", updated_at = CURRENT_TIMESTAMP"
      ],
      this.label,
      content,
      content
    );
  }
}
