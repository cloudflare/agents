/**
 * The fiber tables of a release before fibers ran on Tasks. Tests write
 * rows into them to stand in for an older release's interrupted fibers,
 * which the Agent carries forward into fiber runs when it recovers.
 */
export function createLegacyFiberTables(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cf_agents_runs (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, snapshot TEXT,
      created_at INTEGER NOT NULL, completed_at INTEGER, outcome TEXT,
      error_message TEXT, recovery_crashes INTEGER NOT NULL DEFAULT 0
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cf_agents_fibers (
      fiber_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE,
      name TEXT NOT NULL, status TEXT NOT NULL, snapshot TEXT,
      metadata_json TEXT, error_message TEXT, created_at INTEGER NOT NULL,
      started_at INTEGER, completed_at INTEGER
    )
  `);
}

/** Open fiber runs: a body running, or one awaiting its recovery. */
export const OPEN_FIBER_RUNS_SQL = `
  SELECT COUNT(*) AS count FROM cf_agents_task_runs
  WHERE definition IN ('__cf_fiber', '__cf_managed_fiber')
    AND (status = 'running'
      OR (status = 'pending' AND coalesce(wait_reason, '') != 'park'))
`;
