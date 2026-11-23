import { SQLITE_ROW_BYTES } from "./internal/platform-limits";

/**
 * What to do about SQLite's size errors, appended to the runtime's message.
 * The row cap depends on the runtime (measured: 8 MiB in production, about
 * 2.2 MB in workerd before 1.20260820, the version every released
 * `@cloudflare/vitest-pool-workers` runs).
 */
function sizeHint(message: string): string {
  if (message.includes("string or blob too big")) {
    return (
      " A row or bound value is larger than this runtime stores: 8 MiB in" +
      " production, about 2.2 MB in local workerd before 1.20260820 (and in" +
      " the vitest pool), 4 MiB before 1.20260930. Upgrade an older local" +
      ` runtime, or keep values under ${SQLITE_ROW_BYTES} bytes per row.`
    );
  }
  if (message.includes("statement too long")) {
    return " A SQL statement may be at most 100,000 bytes: bind values with `?` instead of writing them into the query.";
  }
  return "";
}

/**
 * Error class for SQL execution failures, containing the query that failed.
 */
export class SqlError extends Error {
  /** The SQL query that failed */
  readonly query: string;

  constructor(query: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`SQL query failed: ${message}${sizeHint(message)}`, { cause });
    this.name = "SqlError";
    this.query = query;
  }
}
