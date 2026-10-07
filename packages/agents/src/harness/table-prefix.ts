/**
 * Gives an embedded engine its own namespace in a Durable Object's SQLite
 * database.
 *
 * A harness that embeds an engine with its own schema (OpenCode, pi, …)
 * shares one database with the SDK's tables (`cf_agents_*`) and the host's.
 * Engines that name their tables `session` or `event` and assume they own
 * the database collide with both. `prefixTables` returns a view of
 * `DurableObjectStorage` whose `sql.exec` rewrites the engine's SQL so every
 * table and index it creates or reads is stored as `<prefix><name>`, and
 * its reads of `sqlite_master` see only its own objects, under their
 * unprefixed names.
 *
 * The rewrite is by SQL position, not by word: a name is rewritten where it
 * names a table or index (after `FROM`, `JOIN`, `INTO`, `UPDATE`, `TABLE`,
 * `INDEX`, `REFERENCES`, `RENAME TO`, the `ON` of `CREATE INDEX`, or as a
 * `table.column` qualifier), so a column that shares a table's name is left
 * alone. Names the engine creates are learned from its DDL; names it already
 * has are read from the database on first use. Outside DDL, only learned
 * names are rewritten, so common table expressions, aliases, and table-valued
 * functions pass through.
 *
 * It is a stopgap for engines that have no table prefix option of their own,
 * and it relies on the engine's SQL being ordinary SQLite. Nothing in it is
 * specific to one engine.
 */

/** A SQLite identifier prefix, checked by {@link prefixTables}. */
export type TablePrefix = string;

/**
 * A view of `storage` whose SQL is rewritten into `prefix`'s namespace.
 * Everything other than `sql.exec` is the original storage, so transactions
 * and the rest of the API behave as before.
 *
 * @param storage - The Durable Object's storage.
 * @param prefix - The namespace, such as `opencode_`. Letters, digits and
 *   underscores, starting with a letter; never `_cf_`, which Durable Objects
 *   reserve.
 * @returns The same storage, with `sql.exec` rewritten.
 * @throws When `prefix` is not a valid prefix: a defect in the caller.
 */
export function prefixTables<S extends { readonly sql: SqlStorage }>(
  storage: S,
  prefix: TablePrefix
): S {
  const rewriter = new TablePrefixRewriter(storage.sql, prefix);
  const sql = new Proxy(storage.sql, {
    get(target, property) {
      if (property === "exec") return rewriter.exec;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return new Proxy(storage, {
    get(target, property) {
      if (property === "sql") return sql;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

type Token =
  | { readonly kind: "space"; readonly text: string }
  | { readonly kind: "string"; readonly text: string }
  | { readonly kind: "word"; readonly text: string }
  | {
      readonly kind: "quoted";
      readonly text: string;
      readonly name: string;
      readonly open: string;
      readonly close: string;
    }
  | { readonly kind: "punct"; readonly text: string };

/** Words after which an identifier names a table or index in DDL. */
const DDL_KEYWORDS = new Set(["TABLE", "INDEX", "REFERENCES"]);
/** Words after which an identifier names a table in DML. */
const DML_KEYWORDS = new Set(["FROM", "JOIN", "INTO", "UPDATE"]);
/** Words that may follow `sqlite_master` without being its alias. */
const CLAUSE_KEYWORDS = new Set([
  "WHERE",
  "ORDER",
  "GROUP",
  "LIMIT",
  "JOIN",
  "LEFT",
  "INNER",
  "CROSS",
  "ON",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "HAVING",
  "WINDOW"
]);
const MASTER_TABLES = new Set(["sqlite_master", "sqlite_schema"]);
/**
 * Bare words that follow a table keyword without naming a table:
 * `TABLE IF NOT EXISTS`, `INSERT OR REPLACE INTO`, `FROM (SELECT …)`.
 */
const NOT_NAMES = new Set(["IF", "NOT", "EXISTS", "SELECT", "VALUES", "OR"]);

class TablePrefixRewriter {
  readonly #sql: SqlStorage;
  readonly #prefix: string;
  readonly #masterView: string;
  /** Lower-cased unprefixed names of the engine's tables and indexes. */
  #names: Set<string> | undefined;
  readonly #cache = new Map<string, string>();

  constructor(sql: SqlStorage, prefix: string) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix)) {
      throw new Error(`Invalid table prefix ${JSON.stringify(prefix)}`);
    }
    if (prefix.toLowerCase().startsWith("_cf_")) {
      throw new Error("A table prefix must not start with _cf_");
    }
    this.#sql = sql;
    this.#prefix = prefix;
    const length = prefix.length;
    // The engine's objects only, under their unprefixed names. Prefixes
    // are checked to be plain identifiers, so quoting them is safe.
    this.#masterView =
      `(SELECT type, substr(name, ${length + 1}) AS name, ` +
      `substr(tbl_name, ${length + 1}) AS tbl_name, rootpage, sql ` +
      `FROM sqlite_master WHERE substr(name, 1, ${length}) = '${prefix}')`;
  }

  readonly exec = <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursor<T> => this.#sql.exec<T>(this.rewrite(query), ...bindings);

  rewrite(query: string): string {
    const cached = this.#cache.get(query);
    if (cached !== undefined) return cached;
    const names = this.#known();
    const before = names.size;
    const rewritten = this.#rewrite(tokenize(query), names);
    // A statement that learned names may rewrite differently next time.
    if (names.size === before) this.#cache.set(query, rewritten);
    else this.#cache.clear();
    return rewritten;
  }

  #known(): Set<string> {
    if (this.#names) return this.#names;
    const rows = this.#sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE substr(name, 1, ?) = ?",
        this.#prefix.length,
        this.#prefix
      )
      .toArray();
    this.#names = new Set(
      rows.map((row) => row.name.slice(this.#prefix.length).toLowerCase())
    );
    return this.#names;
  }

  #rewrite(tokens: readonly Token[], names: Set<string>): string {
    const significant = tokens
      .map((token, index) => ({ token, index }))
      .filter(({ token }) => token.kind !== "space");
    const out = tokens.map((token) => token.text);
    const firstWord = upper(significant[0]?.token);
    const isCreateIndex =
      firstWord === "CREATE" &&
      significant.slice(1, 4).some(({ token }) => upper(token) === "INDEX");

    for (let i = 0; i < significant.length; i++) {
      const { token, index } = significant[i];
      if (token.kind !== "word" && token.kind !== "quoted") continue;
      if (token.kind === "word" && NOT_NAMES.has(token.text.toUpperCase())) {
        continue;
      }
      const name = token.kind === "word" ? token.text : token.name;
      const lower = name.toLowerCase();
      const previous = significant[i - 1]?.token;
      const next = significant[i + 1]?.token;
      // `schema.table` or `x.y` where this is the right-hand side.
      if (previous?.text === ".") continue;

      const position = tablePosition(significant, i, isCreateIndex);

      if (position === "dml" && MASTER_TABLES.has(lower)) {
        const aliased =
          upper(next) === "AS" ||
          (next !== undefined &&
            (next.kind === "word" || next.kind === "quoted") &&
            !CLAUSE_KEYWORDS.has(upper(next)));
        out[index] = aliased
          ? this.#masterView
          : `${this.#masterView} AS ${token.text}`;
        continue;
      }
      if (lower.startsWith("sqlite_")) continue;

      if (position === "ddl") {
        names.add(lower);
        out[index] = this.#prefixed(token);
        continue;
      }
      if (position === "dml" && names.has(lower)) {
        out[index] = this.#prefixed(token);
        continue;
      }
      // A qualifier: `"session"."id"`.
      if (
        next?.text === "." &&
        significant[i + 2] !== undefined &&
        names.has(lower)
      ) {
        out[index] = this.#prefixed(token);
        continue;
      }
      // `pragma_table_info('name')` and `PRAGMA table_info(name)`.
      if (lower.startsWith("pragma_") && next?.text === "(") {
        const argument = significant[i + 2];
        if (argument?.token.kind === "string") {
          const inner = argument.token.text.slice(1, -1);
          if (names.has(inner.toLowerCase())) {
            out[argument.index] = `'${this.#prefix}${inner}'`;
          }
        }
      }
      if (
        firstWord === "PRAGMA" &&
        previous?.text === "(" &&
        names.has(lower)
      ) {
        out[index] = this.#prefixed(token);
      }
    }
    // `PRAGMA table_info('name')`: the statement form with a string argument.
    if (firstWord === "PRAGMA") {
      for (let i = 1; i < significant.length; i++) {
        const { token, index } = significant[i];
        if (token.kind !== "string" || significant[i - 1]?.token.text !== "(") {
          continue;
        }
        const inner = token.text.slice(1, -1);
        if (names.has(inner.toLowerCase())) {
          out[index] = `'${this.#prefix}${inner}'`;
        }
      }
    }
    return out.join("");
  }

  #prefixed(token: Token & { readonly kind: "word" | "quoted" }): string {
    return token.kind === "word"
      ? `${this.#prefix}${token.text}`
      : `${token.open}${this.#prefix}${token.name}${token.close}`;
  }
}

type Significant = { readonly token: Token; readonly index: number };

/** Whether the identifier at `i` names a table in DDL, DML, or neither. */
function tablePosition(
  significant: readonly Significant[],
  i: number,
  isCreateIndex: boolean
): "ddl" | "dml" | undefined {
  let j = i - 1;
  // Skip `IF NOT EXISTS` / `IF EXISTS`.
  if (upper(significant[j]?.token) === "EXISTS") {
    j -= 1;
    if (upper(significant[j]?.token) === "NOT") j -= 1;
    if (upper(significant[j]?.token) !== "IF") return undefined;
    j -= 1;
  }
  const keyword = upper(significant[j]?.token);
  if (DDL_KEYWORDS.has(keyword)) return "ddl";
  if (keyword === "TO" && upper(significant[j - 1]?.token) === "RENAME") {
    return "ddl";
  }
  if (keyword === "ON" && isCreateIndex) return "ddl";
  if (DML_KEYWORDS.has(keyword)) return "dml";
  return undefined;
}

function upper(token: Token | undefined): string {
  return token?.kind === "word" ? token.text.toUpperCase() : "";
}

/**
 * Splits SQL into identifiers, literals, and everything else. Comments are
 * kept as whitespace so positions stay intact.
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (/\s/.test(char)) {
      let j = i + 1;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      tokens.push({ kind: "space", text: sql.slice(i, j) });
      i = j;
    } else if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const j = end === -1 ? sql.length : end;
      tokens.push({ kind: "space", text: sql.slice(i, j) });
      i = j;
    } else if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const j = end === -1 ? sql.length : end + 2;
      tokens.push({ kind: "space", text: sql.slice(i, j) });
      i = j;
    } else if (char === "'") {
      const j = closing(sql, i, "'");
      tokens.push({ kind: "string", text: sql.slice(i, j) });
      i = j;
    } else if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      const j = closing(sql, i, close);
      const text = sql.slice(i, j);
      const name = text
        .slice(1, -1)
        .replaceAll(close === "]" ? "]]" : close + close, close);
      tokens.push({ kind: "quoted", text, name, open: char, close });
      i = j;
    } else if (/[A-Za-z_]/.test(char)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      tokens.push({ kind: "word", text: sql.slice(i, j) });
      i = j;
    } else {
      tokens.push({ kind: "punct", text: char });
      i++;
    }
  }
  return tokens;
}

/** The index just past the quote that closes the one at `start`. */
function closing(sql: string, start: number, close: string): number {
  let j = start + 1;
  while (j < sql.length) {
    if (sql[j] === close) {
      if (close !== "]" && sql[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}
