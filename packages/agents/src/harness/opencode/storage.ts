// OpenCode refuses to bootstrap if another capability has already created a
// table. Intercept only its schema-discovery query; all other SQL stays native.
const LIST_TABLES =
  /^\s*SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr\(name, 1, 1\) <> '_'\s*$/;

const OPENCODE_TABLES = new Set(["session", "session_v2"]);

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
