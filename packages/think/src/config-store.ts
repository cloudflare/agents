/**
 * Think's private keyed config rows, in the `think_config` table.
 *
 * Durable: every row. In memory: the last value each key was seen to hold in
 * this isolate, so a write of an unchanged value skips the row. Only this
 * object writes the table, which is what makes the memo safe.
 */

/** Keys Think reads that older versions stored in `assistant_config`. */
const LEGACY_CONFIG_KEYS = [
  "_think_config",
  "lastClientTools",
  "lastBody",
  "skillsFingerprint"
] as const;

/** @internal */
export class ThinkConfigStore {
  readonly #sql: SqlStorage;
  #ready = false;
  readonly #memo = new Map<string, string | undefined>();

  constructor(sql: SqlStorage) {
    this.#sql = sql;
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
    const legacy = this.#sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('assistant_config', 'assistant_config__lifted_v1')`
      )
      .toArray()
      .map((row) => String(row.name));
    // Sessions leaves `assistant_config` alone; these keys are Think's, so
    // Think lifts them into its own table and drops the source.
    const source = legacy.includes("assistant_config")
      ? "assistant_config"
      : legacy.includes("assistant_config__lifted_v1")
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
