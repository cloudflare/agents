/** @internal SQLite and telemetry supplied by the Sessions capability. */

export type SqlParam = ArrayBuffer | string | number | null;

export interface SessionsIo {
  /** Run a read and return every row. */
  sql<T>(query: string, params: SqlParam[]): T[];
  /** Run a write (or DDL) and return the rows it wrote. */
  sqlWrite(query: string, params: SqlParam[]): number;
  /** One synchronous SQLite transaction. */
  transaction<T>(fn: () => T): T;
  /** Capability telemetry event. */
  emit(type: string, payload: Record<string, unknown>): void;
}
