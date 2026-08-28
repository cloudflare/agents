import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";

describe("schema migration: legacy schedules into the job queue", () => {
  it("migrates pre-interval legacy rows and drops the table", async () => {
    const agent = await getAgentByName(
      env.TestMigrationAgent,
      "legacy-pre-interval"
    );

    await agent.simulateOldSchema();
    await evictDurableObject(agent);
    await agent.runMigration();

    expect(await agent.legacyTableExists()).toBe(false);
    expect(await agent.getScheduleCount()).toBe(1);

    const job = await agent.getJobRow("test-old-row");
    expect(job).toBeDefined();
    expect(job?.capability).toBe("scheduler");
    expect(job?.fn).toBe("testCallback");
    // Legacy times were epoch seconds; jobs store epoch milliseconds.
    expect(job?.time).toBe(4102444800 * 1000);
    expect(job?.type).toBe("delayed");

    const schedules = await agent.listMigratedSchedules();
    expect(schedules).toEqual([
      {
        id: "test-old-row",
        callback: "testCallback",
        type: "delayed",
        payload: "hello"
      }
    ]);
  });

  it("migrates every schedule kind, keeps retry options, and marks intervals single-flight", async () => {
    const agent = await getAgentByName(
      env.TestMigrationAgent,
      "legacy-full-schema"
    );

    await agent.simulateFullLegacySchema();
    await evictDurableObject(agent);
    await agent.runMigration();

    expect(await agent.legacyTableExists()).toBe(false);

    const schedules = await agent.listMigratedSchedules();
    expect(schedules.map((s) => s.id)).toEqual([
      "row-cron",
      "row-delayed",
      "row-interval",
      "row-scheduled"
    ]);
    expect(schedules.map((s) => s.type).sort()).toEqual([
      "cron",
      "delayed",
      "interval",
      "scheduled"
    ]);

    const interval = await agent.getJobRow("row-interval");
    expect(interval?.singleflight).toBe(1);
    // Jobs carry retry options resolved against the Scheduler defaults so
    // the Lifecycle driver applies the configured policy.
    expect(JSON.parse(interval?.retry_options ?? "null")).toEqual({
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 3000
    });

    // Keep-alive heartbeat orphans are dropped, not migrated.
    expect(await agent.getJobRow("row-keepalive")).toBeNull();
  });

  it("is idempotent (safe to run twice)", async () => {
    const agent = await getAgentByName(
      env.TestMigrationAgent,
      "legacy-idempotent"
    );

    await agent.simulateOldSchema();
    await evictDurableObject(agent);
    await agent.runMigration();
    await evictDurableObject(agent);
    await agent.runMigration();

    expect(await agent.legacyTableExists()).toBe(false);
    expect(await agent.getScheduleCount()).toBe(1);
  });
});
