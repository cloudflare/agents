/**
 * Think's private keyed config rows, in the `think_config` table, as a
 * Lifecycle capability that owns the table and its one migration (lifting
 * Think's keys out of the legacy `assistant_config` table).
 *
 * Durable: every row. In memory: the last value each key was seen to hold in
 * this isolate, so a write of an unchanged value skips the row. Only this
 * capability writes the table, which is what makes the memo safe.
 */

import { LifecycleCapability } from "agents/lifecycle";

/** Keys Think reads that older versions stored in `assistant_config`. */
const LEGACY_CONFIG_KEYS = [
  "_think_config",
  "lastClientTools",
  "lastBody",
  "skillsFingerprint"
] as const;

/**
 * Whether a table named exactly `table` exists. Preparing a query against a
 * missing table fails and reads no rows, while a `sqlite_master` lookup reads
 * every schema row, so the catalog is only consulted once the cheap probe
 * finds something (it also accepts views and other letter cases). For one-way
 * migration checks that run on every wake.
 * @internal
 */
export function tableExists(sql: SqlStorage, table: string): boolean {
  try {
    sql.exec(`SELECT 1 FROM "${table}" LIMIT 0`);
  } catch (error) {
    if (String(error).includes("no such table")) return false;
    throw error;
  }
  return (
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        table
      )
      .toArray().length > 0
  );
}

/** @internal */
export class ThinkConfigStore extends LifecycleCapability {
  #ready = false;
  readonly #memo = new Map<string, string | undefined>();

  constructor() {
    super("think-config");
  }

  /** Create the table and lift legacy rows before anything reads them. */
  override onStart(): void {
    this.#ensureTable();
  }

  get #sql(): SqlStorage {
    return this.lifecycle.storage.sql;
  }

  /** The stored value of `key`, or `undefined`. Always reads the row. */
  get(key: string): string | undefined {
    this.#ensureTable();
    const value = this.#sql
      .exec<{ value: string }>(
        "SELECT value FROM think_config WHERE key = ?",
        key
      )
      .toArray()[0]?.value;
    this.#memo.set(key, value);
    return value;
  }

  /** Store `value` under `key`. Skips the write when the value is unchanged. */
  set(key: string, value: string): void {
    this.#ensureTable();
    if (this.#memo.get(key) === value) return;
    this.#sql.exec(
      "INSERT OR REPLACE INTO think_config (key, value) VALUES (?, ?)",
      key,
      value
    );
    this.#memo.set(key, value);
  }

  /** Delete `key`. Skips the write when the key is known to be absent. */
  delete(key: string): void {
    this.#ensureTable();
    if (this.#memo.has(key) && this.#memo.get(key) === undefined) return;
    this.#sql.exec("DELETE FROM think_config WHERE key = ?", key);
    this.#memo.set(key, undefined);
  }

  /**
   * Lift Think's keys out of the legacy `assistant_config` table (or its
   * `assistant_config__lifted_v1` rename) into `think_config`, then drop the
   * source. A key already in `think_config` wins.
   */
  migrateLegacy(): void {
    // Sessions leaves `assistant_config` alone; these keys are Think's, so
    // Think lifts them into its own table and drops the source.
    const source = tableExists(this.#sql, "assistant_config")
      ? "assistant_config"
      : tableExists(this.#sql, "assistant_config__lifted_v1")
        ? "assistant_config__lifted_v1"
        : null;
    if (!source) return;

    for (const key of LEGACY_CONFIG_KEYS) {
      const value = this.#sql
        .exec<{ value: string }>(
          `SELECT value FROM ${source} WHERE session_id = '' AND key = ?`,
          key
        )
        .toArray()[0]?.value;
      if (value !== undefined) {
        this.#sql.exec(
          "INSERT OR IGNORE INTO think_config (key, value) VALUES (?, ?)",
          key,
          value
        );
      }
    }
    // Config is a handful of small rows and every key Think reads now lives in
    // think_config, so the source has nothing left to give.
    this.#sql.exec(`DROP TABLE ${source}`);
  }

  #ensureTable(): void {
    if (this.#ready) return;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS think_config (
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (key)
      )
    `);
    this.migrateLegacy();
    this.#ready = true;
  }
}
