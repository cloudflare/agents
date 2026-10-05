/**
 * OpenCode's view of the object's storage.
 *
 * On first boot OpenCode lists the database's tables and creates its schema
 * only if there are none, refusing any other database with "Database is not
 * empty and has no session table". It ignores tables whose names start with
 * `_`, and nothing else. But the object's SQLite database is shared: the
 * Lifecycle's job table, a `Workspace`, or any other capability may have
 * made tables before OpenCode's first boot, and capability order cannot
 * always prevent it.
 *
 * So OpenCode gets a view of the storage whose answer to that one query
 * counts only OpenCode's tables: while OpenCode has no `session` table, the
 * database is empty as far as it can tell. Every other statement, and every
 * other storage method, goes to the real storage unchanged. OpenCode's
 * schema then sits beside the other tables; its names (`session`,
 * `message`, `project`, ...) do not collide with the SDK's (`cf_*`) or a
 * Workspace's (`vfs_*`, `computer_*`).
 *
 * This is the same kind of narrow SQL rewrite `agents/harness/pi` makes for
 * its table prefix. If OpenCode ever scopes its emptiness check, remove it.
 */

/** OpenCode's emptiness check, as `DatabaseMigration.apply` sends it. */
const LIST_TABLES =
  /^\s*SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr\(name, 1, 1\) <> '_'\s*$/;

/** The tables whose presence means OpenCode has bootstrapped. */
const OPENCODE_TABLES = new Set(["session", "session_v2"]);

/** An empty result with the same column as the check's. */
const NO_TABLES = "SELECT name FROM sqlite_master WHERE 0";

type Storage = { readonly sql: SqlStorage };

export function openCodeStorage<S extends Storage>(storage: S): S {
  const sql = storage.sql;
  const exec: SqlStorage["exec"] = (query, ...bindings) => {
    if (!LIST_TABLES.test(query)) return sql.exec(query, ...bindings);
    const tables = sql.exec<{ name: string }>(query, ...bindings).toArray();
    return tables.some((table) => OPENCODE_TABLES.has(table.name))
      ? sql.exec(query, ...bindings)
      : sql.exec(NO_TABLES);
  };
  const view = new Proxy(sql, {
    get(target, property) {
      if (property === "exec") return exec;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return new Proxy(storage, {
    get(target, property) {
      if (property === "sql") return view;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
