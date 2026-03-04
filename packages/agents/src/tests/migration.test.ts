import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "..";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("schema migration: CHECK constraint on schedules type", () => {
  it("inserting type='interval' fails with the old CHECK constraint", async () => {
    const agent = await getAgentByName(
      env.TestMigrationAgent,
      "old-constraint-fails"
    );

    // Downgrade to old schema (no 'interval' in CHECK)
    await agent.simulateOldSchema();

    // Attempting to insert type='interval' should fail on the CHECK constraint
    // (use old-columns-only variant to avoid missing-column errors)
    const result = await agent.tryInsertIntervalOldColumns();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("CHECK constraint failed");
  });

  it("migration updates CHECK constraint to allow 'interval'", async () => {
    const agent = await getAgentByName(
      env.TestMigrationAgent,
      "migration-updates-constraint"
    );

    // Downgrade to old schema
    await agent.simulateOldSchema();

    // Run the migration
    await agent.runMigration();

    // Now interval inserts should succeed
    const result = await agent.tryInsertInterval();
    expect(result.ok).toBe(true);
  });

  it("migration preserves existing data", async () => {
    const agent = await getAgentByName(
      env.TestMigrationAgent,
      "migration-preserves-data"
    );

    // Downgrade to old schema (inserts a test row)
    await agent.simulateOldSchema();
    expect(await agent.getScheduleCount()).toBe(1);

    // Run the migration
    await agent.runMigration();

    // Old row should still be there with correct data
    const row = await agent.getOldRow();
    expect(row).toBeDefined();
    expect(row?.id).toBe("test-old-row");
    expect(row?.callback).toBe("testCallback");
    expect(row?.payload).toBe('"hello"');
    expect(row?.type).toBe("delayed");

    // Total count should still be 1 (migration didn't duplicate or lose rows)
    expect(await agent.getScheduleCount()).toBe(1);
  });

  it("migration updates the DDL in sqlite_master", async () => {
    const agent = await getAgentByName(
      env.TestMigrationAgent,
      "migration-updates-ddl"
    );

    // Downgrade to old schema
    await agent.simulateOldSchema();

    const oldDDL = await agent.getSchedulesDDL();
    expect(oldDDL).not.toContain("'interval'");

    // Run the migration
    await agent.runMigration();

    const newDDL = await agent.getSchedulesDDL();
    expect(newDDL).toContain("'interval'");
  });

  it("migration fixes intermediate state (columns exist, old CHECK)", async () => {
    const agent = await getAgentByName(
      env.TestMigrationAgent,
      "intermediate-state"
    );

    // Simulate a table that already has intervalSeconds/running/etc. columns
    // (from addColumnIfNotExists) but still has the old 3-type CHECK constraint.
    // This is the most common real-world path — users on versions between
    // the column-add and CHECK-fix releases.
    await agent.simulateIntermediateSchema();

    // Interval inserts should still fail (CHECK is the old one)
    const before = await agent.tryInsertInterval();
    expect(before.ok).toBe(false);
    expect(before.error).toContain("CHECK constraint failed");

    // Run migration — should detect missing 'interval' and recreate table
    await agent.runMigration();

    // Now interval inserts should work
    const after = await agent.tryInsertInterval();
    expect(after.ok).toBe(true);

    // Existing data preserved
    const row = await agent.getOldRow();
    expect(row).toBeDefined();
    expect(row?.id).toBe("test-old-row");
    expect(row?.type).toBe("delayed");
  });

  it("migration handles leftover cf_agents_schedules_new table", async () => {
    const agent = await getAgentByName(
      env.TestMigrationAgent,
      "leftover-new-table"
    );

    // Downgrade to old schema
    await agent.simulateOldSchema();

    // Simulate a leftover _new table from a previous partial migration
    await agent.simulateLeftoverNewTable();

    // Migration should clean up the leftover and complete successfully
    await agent.runMigration();

    const result = await agent.tryInsertInterval();
    expect(result.ok).toBe(true);

    const row = await agent.getOldRow();
    expect(row).toBeDefined();
    expect(row?.id).toBe("test-old-row");
  });

  it("migration preserves all schedule types (scheduled, delayed, cron)", async () => {
    const agent = await getAgentByName(
      env.TestMigrationAgent,
      "multiple-types"
    );

    // Start with intermediate schema (has columns, old CHECK)
    await agent.simulateIntermediateSchema();

    // Insert one row of each old type (simulateIntermediateSchema already inserted one delayed row)
    // Drop the default row and insert fresh ones for clarity
    await agent.insertMultipleTypes();

    // Run migration
    await agent.runMigration();

    // All three types should survive
    const rows = await agent.getAllRows();
    const types = rows.map((r) => r.type).sort();
    expect(types).toContain("cron");
    expect(types).toContain("delayed");
    expect(types).toContain("scheduled");

    // Can also insert interval now
    const result = await agent.tryInsertInterval();
    expect(result.ok).toBe(true);
  });

  it("migration is idempotent (safe to run twice)", async () => {
    const agent = await getAgentByName(
      env.TestMigrationAgent,
      "migration-idempotent"
    );

    // Downgrade to old schema
    await agent.simulateOldSchema();

    // Run migration twice — second run should be a no-op
    await agent.runMigration();
    await agent.runMigration();

    // Everything should still work
    const result = await agent.tryInsertInterval();
    expect(result.ok).toBe(true);

    const row = await agent.getOldRow();
    expect(row).toBeDefined();
    expect(row?.id).toBe("test-old-row");
  });
});
