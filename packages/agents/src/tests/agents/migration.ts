import { Agent } from "../../index.ts";

const SCHEDULE_SCHEMA_VERSION_KEY = "cf_agents:schedules_schema_version";

/**
 * Test agent for verifying the legacy `cf_agents_schedules` → job-queue
 * migration. Provides methods to seed legacy tables and re-run migration.
 */
export class TestMigrationAgent extends Agent {
  /**
   * Seed the pre-interval legacy schema (SDK <= 0.4.0: no intervalSeconds,
   * running, retry, or owner columns) with one delayed row, and clear the
   * schema version so the next Lifecycle startup migrates.
   */
  async simulateOldSchema(): Promise<void> {
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS cf_agents_schedules");
    this.ctx.storage.sql.exec(
      "DELETE FROM cf_agents_jobs WHERE capability = 'scheduler'"
    );

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
    this.ctx.storage.sql.exec(`
      INSERT INTO cf_agents_schedules (id, callback, payload, type, time, delayInSeconds)
      VALUES ('test-old-row', 'testCallback', '"hello"', 'delayed', 4102444800, 5)
    `);
    await this.ctx.storage.delete(SCHEDULE_SCHEMA_VERSION_KEY);
  }

  /**
   * Seed the full legacy schema (interval allowed, retry/owner columns) with
   * one row of each kind, plus a keep-alive heartbeat orphan that migration
   * must drop.
   */
  async simulateFullLegacySchema(): Promise<void> {
    this.ctx.storage.sql.exec("DROP TABLE IF EXISTS cf_agents_schedules");
    this.ctx.storage.sql.exec(
      "DELETE FROM cf_agents_jobs WHERE capability = 'scheduler'"
    );

    this.ctx.storage.sql.exec(`
      CREATE TABLE cf_agents_schedules (
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
        retry_options TEXT,
        owner_path TEXT,
        owner_path_key TEXT
      )
    `);
    this.ctx.storage.sql.exec(`
      INSERT INTO cf_agents_schedules (id, callback, payload, type, time, delayInSeconds)
      VALUES ('row-delayed', 'testCallback', '"d"', 'delayed', 4102444801, 5)
    `);
    this.ctx.storage.sql.exec(`
      INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
      VALUES ('row-scheduled', 'testCallback', '"s"', 'scheduled', 4102444802)
    `);
    this.ctx.storage.sql.exec(`
      INSERT INTO cf_agents_schedules (id, callback, payload, type, time, cron)
      VALUES ('row-cron', 'testCallback', '"c"', 'cron', 4102444803, '0 * * * *')
    `);
    this.ctx.storage.sql.exec(`
      INSERT INTO cf_agents_schedules
        (id, callback, payload, type, time, intervalSeconds, running, retry_options)
      VALUES
        ('row-interval', 'heartbeat', 'null', 'interval', 4102444804, 30, 1,
         '{"maxAttempts":5}')
    `);
    this.ctx.storage.sql.exec(`
      INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
      VALUES ('row-keepalive', '_cf_keepAliveHeartbeat', 'null', 'scheduled', 4102444805)
    `);
    await this.ctx.storage.delete(SCHEDULE_SCHEMA_VERSION_KEY);
  }

  /** Enter Scheduler's real async API, which starts Lifecycle and migrates. */
  async runMigration(): Promise<void> {
    await this.scheduler.list();
  }

  /** Whether the legacy table still exists. */
  async legacyTableExists(): Promise<boolean> {
    return (
      this.ctx.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='cf_agents_schedules'"
        )
        .toArray().length > 0
    );
  }

  /** Raw job row for one migrated schedule. */
  async getJobRow(id: string): Promise<{
    id: string;
    capability: string;
    fn: string;
    time: number;
    singleflight: number;
    retry_options: string | null;
    type: string | null;
  } | null> {
    const rows = this.sql<{
      id: string;
      capability: string;
      fn: string;
      time: number;
      singleflight: number;
      retry_options: string | null;
      type: string | null;
    }>`
      SELECT id, capability, fn, time, singleflight, retry_options,
             json_extract(payload, '$.type') AS type
      FROM cf_agents_jobs WHERE id = ${id}
    `;
    return rows[0] ?? null;
  }

  /**
   * Migrated schedules through the public Scheduler read API. The payload is
   * typed as its concrete string shape: an `unknown` field collapses the
   * whole element type to `never` across the Durable Object RPC stub
   * boundary (Workers RPC drops non-serializable-typed values), and every
   * payload this harness seeds is a string.
   */
  async listMigratedSchedules(): Promise<
    Array<{ id: string; callback: string; type: string; payload: string }>
  > {
    const schedules = await this.scheduler.list();
    return schedules
      .map((schedule) => ({
        id: schedule.id,
        callback: schedule.callback,
        type: schedule.type,
        payload: schedule.payload as string
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Count scheduler-owned jobs. */
  async getScheduleCount(): Promise<number> {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_jobs WHERE capability = 'scheduler'
    `;
    return rows[0].count;
  }

  // No-op callbacks referenced by test data
  testCallback() {}
  heartbeat() {}
}
