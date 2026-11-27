/**
 * Storage meter: wraps one Durable Object's `ctx.storage` before the agent's
 * constructor runs, so every SQL statement, KV op, alarm call and sync made
 * by the SDK is counted. Counting stops while `paused` (the probe's own
 * measurement queries).
 */

export type Counts = {
  sqlStatements: number;
  rowsRead: number;
  rowsWritten: number;
  kvGet: number;
  kvPut: number;
  kvDelete: number;
  kvList: number;
  asyncGet: number;
  asyncPut: number;
  asyncDelete: number;
  asyncList: number;
  setAlarm: number;
  deleteAlarm: number;
  getAlarm: number;
  sync: number;
  transactions: number;
};

export function zeroCounts(): Counts {
  return {
    sqlStatements: 0,
    rowsRead: 0,
    rowsWritten: 0,
    kvGet: 0,
    kvPut: 0,
    kvDelete: 0,
    kvList: 0,
    asyncGet: 0,
    asyncPut: 0,
    asyncDelete: 0,
    asyncList: 0,
    setAlarm: 0,
    deleteAlarm: 0,
    getAlarm: 0,
    sync: 0,
    transactions: 0
  };
}

type Cursor = { rowsRead: number; rowsWritten: number };

export class Meter {
  counts = zeroCounts();
  /** Cursors since the last reset; row counts are read when summed. */
  #cursors: Array<Cursor & { q?: string }> = [];
  #cursorQ = new WeakMap<object, string>();
  paused = 0;
  /** Statement text -> count, for the top-N list. */
  statements = new Map<string, number>();
  constructedAt = Date.now();

  reset() {
    this.counts = zeroCounts();
    this.#cursors = [];
    this.statements.clear();
  }

  snapshot(): Counts {
    const c = { ...this.counts };
    for (const cur of this.#cursors) {
      c.rowsRead += cur.rowsRead;
      c.rowsWritten += cur.rowsWritten;
    }
    return c;
  }

  topStatements(n = 400) {
    const rows = new Map<string, { r: number; w: number }>();
    for (const c of this.#cursors) {
      const q = this.#cursorQ.get(c as object);
      if (!q) continue;
      const e = rows.get(q) ?? { r: 0, w: 0 };
      e.r += c.rowsRead;
      e.w += c.rowsWritten;
      rows.set(q, e);
    }
    return [...this.statements.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([q, count]) => ({
        count,
        rr: rows.get(q)?.r,
        rw: rows.get(q)?.w,
        q: q.replace(/\s+/g, " ").trim().slice(0, 140)
      }));
  }

  async quiet<T>(fn: () => Promise<T> | T): Promise<T> {
    this.paused++;
    try {
      return await fn();
    } finally {
      this.paused--;
    }
  }

  install(storage: DurableObjectStorage) {
    const meter = this;
    const sql = storage.sql;
    const exec = sql.exec.bind(sql);
    // oxlint-disable-next-line typescript/no-explicit-any -- patching a runtime object
    (sql as any).exec = (query: string, ...bindings: unknown[]) => {
      const cursor = exec(query, ...bindings);
      if (!meter.paused) {
        meter.counts.sqlStatements++;
        meter.#cursors.push(cursor as unknown as Cursor);
        meter.#cursorQ.set(cursor as object, query);
        meter.statements.set(query, (meter.statements.get(query) ?? 0) + 1);
        if (/^\s*INSERT INTO cf_agents_jobs/i.test(query)) {
          const label = `job push ${String(bindings[1])}:${String(bindings[2])}`;
          meter.statements.set(label, (meter.statements.get(label) ?? 0) + 1);
        }
      }
      return cursor;
    };
    const count = (key: keyof Counts) => {
      if (!meter.paused) meter.counts[key]++;
    };
    // oxlint-disable-next-line typescript/no-explicit-any -- patching a runtime object
    const wrap = (obj: any, name: string, key: keyof Counts) => {
      const orig = obj[name];
      if (typeof orig !== "function") return;
      const bound = orig.bind(obj);
      obj[name] = (...args: unknown[]) => {
        count(key);
        if (!meter.paused) {
          const a = args[0];
          const k =
            typeof a === "string"
              ? a
              : Array.isArray(a)
                ? a.join(",")
                : a && typeof a === "object"
                  ? "prefix:" + String((a as { prefix?: string }).prefix ?? "")
                  : "";
          const label = `${key} ${k.slice(0, 80)}`;
          meter.statements.set(label, (meter.statements.get(label) ?? 0) + 1);
        }
        return bound(...args);
      };
    };
    const kv = (storage as unknown as { kv?: object }).kv;
    if (kv) {
      wrap(kv, "get", "kvGet");
      wrap(kv, "put", "kvPut");
      wrap(kv, "delete", "kvDelete");
      wrap(kv, "list", "kvList");
    }
    wrap(storage, "get", "asyncGet");
    wrap(storage, "put", "asyncPut");
    wrap(storage, "delete", "asyncDelete");
    wrap(storage, "list", "asyncList");
    wrap(storage, "setAlarm", "setAlarm");
    wrap(storage, "deleteAlarm", "deleteAlarm");
    wrap(storage, "getAlarm", "getAlarm");
    wrap(storage, "sync", "sync");
    wrap(storage, "transactionSync", "transactions");
    wrap(storage, "transaction", "transactions");
  }
}

export type TableStat = { table: string; rows: number; bytes: number };

/** Rows and summed value bytes per table (dbstat is not available). */
export function tableStats(sql: SqlStorage): TableStat[] {
  const tables = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    )
    .toArray();
  const out: TableStat[] = [];
  for (const { name } of tables) {
    if (name.startsWith("perf_")) continue;
    const cols = sql
      .exec<{ name: string }>(`SELECT name FROM pragma_table_info('${name}')`)
      .toArray()
      .map((c) => c.name);
    const sum = cols.length
      ? cols.map((c) => `COALESCE(LENGTH("${c}"),0)`).join(" + ")
      : "0";
    const r = sql
      .exec<{ n: number; b: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(${sum}),0) AS b FROM "${name}"`
      )
      .one();
    out.push({ table: name, rows: r.n, bytes: r.b });
  }
  return out;
}
