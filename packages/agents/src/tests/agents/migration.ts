import { Agent } from "../../index.ts";

/**
 * Test agent for verifying SQL schema migrations.
 * Provides methods to simulate old table schemas and re-run migration logic.
 */
export class TestMigrationAgent extends Agent {
  /**
   * Downgrade cf_agents_schedules to the pre-interval schema.
   * This simulates a DO that was created with SDK <= 0.4.0 where the CHECK
   * constraint only allowed ('scheduled', 'delayed', 'cron').
   *
   * We insert a test row first, then recreate with the old constraint to
   * verify the migration preserves existing data.
   */
  async simulateOldSchema(): Promise<void> {
    // Drop the current (already-migrated) table
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS cf_agents_schedules");

    // Recreate with the OLD schema (no 'interval' in CHECK, no intervalSeconds/running/etc.)
    this.ctx.storage.sql.exec(`
      CREATE TABLE cf_agents_schedules (
        id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
        callback TEXT,
        payload TEXT,
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron')),
        time INTEGER,
        delayInSeconds INTEGER,
        cron TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);

    // Insert a row with the old schema to verify data survives migration
    this.ctx.storage.sql.exec(`
      INSERT INTO cf_agents_schedules (id, callback, payload, type, time, delayInSeconds)
      VALUES ('test-old-row', 'testCallback', '"hello"', 'delayed', 1000, 5)
    `);
  }

  /**
   * Simulate the intermediate state: table has all interval columns (from
   * addColumnIfNotExists) but still has the old CHECK constraint without
   * 'interval'. This is the most common real-world migration path — users
   * on SDK versions that added the columns but not the CHECK fix.
   */
  async simulateIntermediateSchema(): Promise<void> {
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS cf_agents_schedules");

    this.ctx.storage.sql.exec(`
      CREATE TABLE cf_agents_schedules (
        id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
        callback TEXT,
        payload TEXT,
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron')),
        time INTEGER,
        delayInSeconds INTEGER,
        cron TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        intervalSeconds INTEGER,
        running INTEGER DEFAULT 0,
        execution_started_at INTEGER,
        retry_options TEXT
      )
    `);

    // Insert a row to verify data survives migration
    this.ctx.storage.sql.exec(`
      INSERT INTO cf_agents_schedules (id, callback, payload, type, time, delayInSeconds)
      VALUES ('test-old-row', 'testCallback', '"hello"', 'delayed', 1000, 5)
    `);
  }

  /**
   * Run the column-add + CHECK-constraint migration logic.
   * This is the same code that runs in the Agent constructor.
   */
  async runMigration(): Promise<void> {
    // Step 1: Add missing columns (same as constructor)
    const addColumnIfNotExists = (sql: string) => {
      try {
        this.ctx.storage.sql.exec(sql);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!message.toLowerCase().includes("duplicate column")) {
          throw e;
        }
      }
    };

    addColumnIfNotExists(
      "ALTER TABLE cf_agents_schedules ADD COLUMN intervalSeconds INTEGER"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agents_schedules ADD COLUMN running INTEGER DEFAULT 0"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agents_schedules ADD COLUMN execution_started_at INTEGER"
    );
    addColumnIfNotExists(
      "ALTER TABLE cf_agents_schedules ADD COLUMN retry_options TEXT"
    );

    // Step 2: Recreate table if CHECK constraint is missing 'interval'
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='cf_agents_schedules'"
      )
      .toArray();
    if (rows.length > 0) {
      const ddl = String(rows[0].sql);
      if (!ddl.includes("'interval'")) {
        // Drop any leftover temp table from a previous partial migration
        this.ctx.storage.sql.exec(
          "DROP TABLE IF EXISTS cf_agents_schedules_new"
        );
        this.ctx.storage.sql.exec(`
          CREATE TABLE cf_agents_schedules_new (
            id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
            callback TEXT,
            payload TEXT,
            type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
            time INTEGER,
            delayInSeconds INTEGER,
            cron TEXT,
            intervalSeconds INTEGER,
            running INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (unixepoch()),
            execution_started_at INTEGER,
            retry_options TEXT
          )
        `);
        this.ctx.storage.sql.exec(`
          INSERT INTO cf_agents_schedules_new
            (id, callback, payload, type, time, delayInSeconds, cron,
             intervalSeconds, running, created_at, execution_started_at, retry_options)
          SELECT id, callback, payload, type, time, delayInSeconds, cron,
                 intervalSeconds, running, created_at, execution_started_at, retry_options
          FROM cf_agents_schedules
        `);
        this.ctx.storage.sql.exec("DROP TABLE cf_agents_schedules");
        this.ctx.storage.sql.exec(
          "ALTER TABLE cf_agents_schedules_new RENAME TO cf_agents_schedules"
        );
      }
    }
  }

  /**
   * Try inserting a row with type='interval'.
   * Uses all columns available in the migrated schema.
   * Returns true on success, or the error message on failure.
   */
  async tryInsertInterval(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.ctx.storage.sql.exec(`
        INSERT INTO cf_agents_schedules (id, callback, payload, type, intervalSeconds, time, running)
        VALUES ('test-interval', 'heartbeat', 'null', 'interval', 30, 1000, 0)
      `);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Try inserting type='interval' using only columns that exist in the old
   * (pre-migration) schema. This isolates the CHECK constraint failure from
   * any missing-column errors.
   */
  async tryInsertIntervalOldColumns(): Promise<{
    ok: boolean;
    error?: string;
  }> {
    try {
      this.ctx.storage.sql.exec(`
        INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
        VALUES ('test-interval-old', 'heartbeat', 'null', 'interval', 1000)
      `);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Create a leftover cf_agents_schedules_new table to simulate a partial
   * migration that was interrupted. The real migration should clean this up.
   */
  async simulateLeftoverNewTable(): Promise<void> {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_agents_schedules_new (
        id TEXT PRIMARY KEY
      )
    `);
  }

  /**
   * Insert rows with all three old schedule types to verify they all
   * survive the migration.
   */
  async insertMultipleTypes(): Promise<void> {
    this.ctx.storage.sql.exec(`
      INSERT INTO cf_agents_schedules (id, callback, payload, type, time, delayInSeconds)
      VALUES ('row-delayed', 'testCallback', '"d"', 'delayed', 1000, 5)
    `);
    this.ctx.storage.sql.exec(`
      INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
      VALUES ('row-scheduled', 'testCallback', '"s"', 'scheduled', 2000)
    `);
    this.ctx.storage.sql.exec(`
      INSERT INTO cf_agents_schedules (id, callback, payload, type, cron)
      VALUES ('row-cron', 'testCallback', '"c"', 'cron', '0 * * * *')
    `);
  }

  /**
   * Get all rows ordered by id, returning type and id for verification.
   */
  async getAllRows(): Promise<{ id: string; type: string }[]> {
    return this.sql<{
      id: string;
      type: string;
    }>`SELECT id, type FROM cf_agents_schedules ORDER BY id`;
  }

  /** Get the DDL for cf_agents_schedules from sqlite_master. */
  async getSchedulesDDL(): Promise<string | null> {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='cf_agents_schedules'"
      )
      .toArray();
    return rows.length > 0 ? String(rows[0].sql) : null;
  }

  /** Get the pre-migration test row to verify data was preserved. */
  async getOldRow(): Promise<{
    id: string;
    callback: string;
    payload: string;
    type: string;
  } | null> {
    const rows = this.sql<{
      id: string;
      callback: string;
      payload: string;
      type: string;
    }>`SELECT id, callback, payload, type FROM cf_agents_schedules WHERE id = 'test-old-row'`;
    return rows[0] ?? null;
  }

  /** Count all rows in cf_agents_schedules. */
  async getScheduleCount(): Promise<number> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
    `;
    return rows[0].count;
  }

  // No-op callback referenced by test data
  testCallback() {}
  heartbeat() {}
}
