/**
 * Error class for SQL execution failures, containing the query that failed.
 */
export class SqlError extends Error {
  /** The SQL query that failed */
  readonly query: string;

  constructor(query: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`SQL query failed: ${message}`, { cause });
    this.name = "SqlError";
    this.query = query;
  }
}
