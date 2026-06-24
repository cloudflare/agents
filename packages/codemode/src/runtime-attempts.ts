/** Internal durable generation fence for Code Mode execution passes. */
export class ExecutionAttemptStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS cm_attempts (
        execution_id TEXT PRIMARY KEY,
        attempt INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO cm_attempts (execution_id, attempt)
        SELECT id, 0 FROM cm_executions;
    `);
  }

  begin(executionId: string): void {
    this.sql.exec(
      `INSERT INTO cm_attempts (execution_id, attempt) VALUES (?, 0)`,
      executionId
    );
  }

  current(executionId: string): number {
    const row = this.sql
      .exec<{ attempt: number }>(
        `SELECT attempt FROM cm_attempts WHERE execution_id = ?`,
        executionId
      )
      .toArray()[0];
    if (!row) throw new Error(`No execution "${executionId}"`);
    return row.attempt;
  }

  advance(executionId: string, expectedAttempt: number): number | null {
    const next = expectedAttempt + 1;
    const updated = this.sql.exec(
      `UPDATE cm_attempts SET attempt = ?
        WHERE execution_id = ? AND attempt = ?
          AND EXISTS (
            SELECT 1 FROM cm_executions
            WHERE id = cm_attempts.execution_id AND status = 'running'
          )`,
      next,
      executionId,
      expectedAttempt
    );
    return updated.rowsWritten > 0 ? next : null;
  }

  isCurrentRunning(executionId: string, attempt: number): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM cm_executions
            WHERE id = ? AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM cm_attempts
                WHERE execution_id = cm_executions.id AND attempt = ?
              )`,
          executionId,
          attempt
        )
        .toArray().length > 0
    );
  }

  recordResult(
    executionId: string,
    seq: number,
    result: string | null,
    attempt: number
  ): boolean {
    const updated = this.sql.exec(
      `UPDATE cm_log SET result = ?, state = 'applied'
        WHERE execution_id = ? AND seq = ?
          AND (state = 'executing' OR (state = 'applied' AND ephemeral = 1))
          AND EXISTS (
            SELECT 1 FROM cm_executions
            WHERE id = ? AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM cm_attempts
                WHERE execution_id = cm_executions.id AND attempt = ?
              )
          )`,
      result,
      executionId,
      seq,
      executionId,
      attempt
    );
    return updated.rowsWritten > 0;
  }

  delete(executionId: string): void {
    this.sql.exec(
      `DELETE FROM cm_attempts WHERE execution_id = ?`,
      executionId
    );
  }
}
