/** Node.js adapter for the SqlDatabase seam, backed by built-in node:sqlite. */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDatabase, SqlRow } from "../substrate.js";

export interface NodeSqliteDatabase extends SqlDatabase {
  readonly raw: DatabaseSync;
  close(): void;
}

/** Create a SqlDatabase suitable for local demos and Node.js tests. */
export function nodeSqliteDb(path = ":memory:"): NodeSqliteDatabase {
  const raw = new DatabaseSync(path);
  let txDepth = 0;

  return {
    raw,
    exec(query: string, ...bindings: ReadonlyArray<unknown>): SqlRow[] {
      if (/^\s*(CREATE|DROP|BEGIN|COMMIT|ROLLBACK)/i.test(query)) {
        raw.exec(query);
        return [];
      }
      const params = bindings as SQLInputValue[];
      const stmt = raw.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        return stmt.all(...params) as SqlRow[];
      }
      stmt.run(...params);
      return [];
    },
    transaction<T>(fn: () => T): T {
      if (txDepth > 0) return fn();
      raw.exec("BEGIN");
      txDepth += 1;
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      } finally {
        txDepth -= 1;
      }
    },
    close() {
      raw.close();
    }
  };
}
