/**
 * Tests for two storage optimizations:
 *
 * 1. Schema version gating (cf_schema_version row in cf_agents_state)
 *    - Constructor DDL is skipped on established DOs whose schema is current.
 *    - Fresh DOs (no version row) run all migrations and stamp the version.
 *
 * 2. Single-row state optimization
 *    - State uses one row (cf_state_row_id) instead of two.
 *    - STATE_WAS_CHANGED row is no longer written.
 *    - Legacy wasChanged rows are cleaned up during migration.
 *    - Falsy state values (null, 0, false, "") are handled correctly via
 *      row-existence check instead of truthiness check.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";

/**
 * Schema DDL snapshot — the canonical DDL for the current CURRENT_SCHEMA_VERSION.
 *
 * If you change any table definition in the Agent constructor (add/remove
 * columns, change constraints, add tables, etc.), this snapshot will break.
 * When it does:
 *   1. Bump CURRENT_SCHEMA_VERSION in src/index.ts
 *   2. Add migration logic for the change inside the `if (schemaVersion < ...)` block
 *   3. Update this snapshot to match the new DDL
 */
const EXPECTED_SCHEMA_DDL = [
  `CREATE TABLE cf_agents_facet_runs (
          owner_path TEXT NOT NULL,
          owner_path_key TEXT NOT NULL,
          run_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (owner_path_key, run_id)
        )`,
  `CREATE TABLE cf_agents_mcp_servers (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            server_url TEXT NOT NULL,
            callback_url TEXT NOT NULL,
            client_id TEXT,
            auth_url TEXT,
            server_options TEXT
          )`,
  `CREATE TABLE cf_agents_queues (
          id TEXT PRIMARY KEY NOT NULL,
          payload TEXT,
          callback TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        , retry_options TEXT)`,
  `CREATE TABLE cf_agents_runs (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          snapshot TEXT,
          created_at INTEGER NOT NULL
        )`,
  `CREATE TABLE cf_agents_schedules (
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
        )`,
  `CREATE TABLE cf_agents_state (
        id TEXT PRIMARY KEY NOT NULL,
        state TEXT
      )`,
  `CREATE TABLE cf_agents_workflows (
          id TEXT PRIMARY KEY NOT NULL,
          workflow_id TEXT NOT NULL UNIQUE,
          workflow_name TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'queued', 'running', 'paused', 'errored',
            'terminated', 'complete', 'waiting',
            'waitingForPause', 'unknown'
          )),
          metadata TEXT,
          error_name TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          completed_at INTEGER
        )`
];

describe("schema DDL snapshot", () => {
  it("should match the expected DDL for the current schema version", async () => {
    const agent = await getAgentByName(
      env.TestStateAgent,
      `ddl-snapshot-${crypto.randomUUID()}`
    );

    const actual = await agent.getSchemaSnapshot();

    expect(actual).toEqual(EXPECTED_SCHEMA_DDL);
  });
});

describe("schema version gating", () => {
  it("should set PRAGMA user_version after first construction", async () => {
    const agent = await getAgentByName(
      env.TestStateAgent,
      `schema-version-set-${crypto.randomUUID()}`
    );

    const version = await agent.getSchemaVersion();
    expect(version).toBe(5);
  });

  it("should have all required tables after construction", async () => {
    const agent = await getAgentByName(
      env.TestStateAgent,
      `tables-exist-${crypto.randomUUID()}`
    );

    expect(await agent.tableExists("cf_agents_state")).toBe(true);
    expect(await agent.tableExists("cf_agents_queues")).toBe(true);
    expect(await agent.tableExists("cf_agents_schedules")).toBe(true);
    expect(await agent.tableExists("cf_agents_workflows")).toBe(true);
    expect(await agent.tableExists("cf_agents_mcp_servers")).toBe(true);
    expect(await agent.tableExists("cf_agents_runs")).toBe(true);
    expect(await agent.tableExists("cf_agents_facet_runs")).toBe(true);
  });

  it("should drop every internal table during destroy cleanup", async () => {
    const agent = await getAgentByName(
      env.TestStateAgent,
      `destroy-drops-tables-${crypto.randomUUID()}`
    );

    agent.dropInternalTablesForDestroyTest();

    expect(await agent.tableExists("cf_agents_state")).toBe(false);
    expect(await agent.tableExists("cf_agents_queues")).toBe(false);
    expect(await agent.tableExists("cf_agents_schedules")).toBe(false);
    expect(await agent.tableExists("cf_agents_workflows")).toBe(false);
    expect(await agent.tableExists("cf_agents_mcp_servers")).toBe(false);
    expect(await agent.tableExists("cf_agents_sub_agents")).toBe(false);
    expect(await agent.tableExists("cf_agents_runs")).toBe(false);
    expect(await agent.tableExists("cf_agents_facet_runs")).toBe(false);
  });

  it("should reset to 0 after deleting version row and restore via migration", async () => {
    const name = `schema-upgrade-${crypto.randomUUID()}`;

    // Create agent — sets schema version
    const agent = await getAgentByName(env.TestStateAgent, name);
    expect(await agent.getSchemaVersion()).toBe(5);

    // Set some state
    await agent.updateState({
      count: 42,
      items: ["before-upgrade"],
      lastUpdated: "test"
    });

    // Reset version to 0 (simulates a DO that predates schema versioning)
    await agent.resetSchemaVersion();
    expect(await agent.getSchemaVersion()).toBe(0);

    // Re-run migration manually (constructor won't re-run on same DO)
    await agent.runSchemaMigration();
    expect(await agent.getSchemaVersion()).toBe(5);

    // State should be preserved through re-migration
    const state = await agent.getState();
    expect(state).toEqual({
      count: 42,
      items: ["before-upgrade"],
      lastUpdated: "test"
    });
  });

  it("should clean up legacy wasChanged rows during migration", async () => {
    const name = `cleanup-waschanged-${crypto.randomUUID()}`;

    // Create agent
    const agent = await getAgentByName(env.TestStateAgent, name);

    // Manually insert a legacy wasChanged row
    await agent.insertLegacyWasChangedRow();

    // Verify the wasChanged row exists
    const idsBefore = await agent.getStateRowIds();
    expect(idsBefore).toContain("cf_state_was_changed");

    // Reset version so _ensureSchema() enters the migration block
    await agent.resetSchemaVersion();
    await agent.runSchemaMigration();

    // wasChanged row should be cleaned up
    const idsAfter = await agent.getStateRowIds();
    expect(idsAfter).not.toContain("cf_state_was_changed");
  });

  it("should be idempotent when schema version is already current", async () => {
    const name = `idempotent-${crypto.randomUUID()}`;

    // Create agent and set state
    const agent = await getAgentByName(env.TestStateAgent, name);
    await agent.updateState({
      count: 99,
      items: ["idempotent"],
      lastUpdated: "test"
    });

    // Verify version is set
    expect(await agent.getSchemaVersion()).toBe(5);

    // State should still be intact
    const state = await agent.getState();
    expect(state).toEqual({
      count: 99,
      items: ["idempotent"],
      lastUpdated: "test"
    });
  });

  it("should set schema version on agents without initialState", async () => {
    const agent = await getAgentByName(
      env.TestStateAgentNoInitial,
      `no-initial-schema-${crypto.randomUUID()}`
    );

    const version = await agent.getSchemaVersion();
    expect(version).toBe(5);
  });
});

describe("single-row state optimization", () => {
  describe("no wasChanged row written", () => {
    it("should only write one row to cf_agents_state on setState", async () => {
      const agent = await getAgentByName(
        env.TestStateAgent,
        `single-row-${crypto.randomUUID()}`
      );

      await agent.updateState({
        count: 1,
        items: ["test"],
        lastUpdated: "now"
      });

      // Should have exactly 1 row (cf_state_row_id only)
      const count = await agent.getStateRowCount();
      expect(count).toBe(1);

      const ids = await agent.getStateRowIds();
      expect(ids).toEqual(["cf_state_row_id"]);
    });

    it("should only write one row when initialState is persisted on first access", async () => {
      const agent = await getAgentByName(
        env.TestStateAgent,
        `initial-single-row-${crypto.randomUUID()}`
      );

      // First access triggers persistence of initialState
      await agent.getState();

      const count = await agent.getStateRowCount();
      expect(count).toBe(1);

      const ids = await agent.getStateRowIds();
      expect(ids).toEqual(["cf_state_row_id"]);
    });

    it("should not create any rows for agents without initialState until setState is called", async () => {
      const agent = await getAgentByName(
        env.TestStateAgentNoInitial,
        `no-rows-${crypto.randomUUID()}`
      );

      // Access state without setting it
      await agent.getState();

      const count = await agent.getStateRowCount();
      expect(count).toBe(0);
    });

    it("should create exactly one row when setState is called on no-initialState agent", async () => {
      const agent = await getAgentByName(
        env.TestStateAgentNoInitial,
        `one-row-no-initial-${crypto.randomUUID()}`
      );

      await agent.updateState({ custom: "data" });

      const count = await agent.getStateRowCount();
      expect(count).toBe(1);

      const ids = await agent.getStateRowIds();
      expect(ids).toEqual(["cf_state_row_id"]);
    });
  });

  describe("falsy state values via row existence", () => {
    it("should correctly persist and restore null state", async () => {
      const name = `null-state-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestStateAgentNoInitial, name);

      // Set state to null
      await agent.updateState(null);

      // Get new stub to force DB read
      const agent2 = await getAgentByName(env.TestStateAgentNoInitial, name);
      const state = await agent2.getState();

      expect(state).toBeNull();
    });

    it("should correctly persist and restore state with value 0", async () => {
      const name = `zero-state-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestStateAgentNoInitial, name);

      await agent.updateState(0);

      const agent2 = await getAgentByName(env.TestStateAgentNoInitial, name);
      const state = await agent2.getState();

      expect(state).toBe(0);
    });

    it("should correctly persist and restore false state", async () => {
      const name = `false-state-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestStateAgentNoInitial, name);

      await agent.updateState(false);

      const agent2 = await getAgentByName(env.TestStateAgentNoInitial, name);
      const state = await agent2.getState();

      expect(state).toBe(false);
    });

    it("should correctly persist and restore empty string state", async () => {
      const name = `empty-string-state-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestStateAgentNoInitial, name);

      await agent.updateState("");

      const agent2 = await getAgentByName(env.TestStateAgentNoInitial, name);
      const state = await agent2.getState();

      expect(state).toBe("");
    });

    it("should handle falsy state injected directly into DB", async () => {
      const agent = await getAgentByName(
        env.TestStateAgentNoInitial,
        `direct-falsy-${crypto.randomUUID()}`
      );

      // Inject JSON null directly
      await agent.insertFalsyState("null");
      const state = await agent.getState();
      expect(state).toBeNull();
    });

    it("should handle 0 state injected directly into DB", async () => {
      const agent = await getAgentByName(
        env.TestStateAgentNoInitial,
        `direct-zero-${crypto.randomUUID()}`
      );

      await agent.insertFalsyState("0");
      const state = await agent.getState();
      expect(state).toBe(0);
    });

    it("should handle false state injected directly into DB", async () => {
      const agent = await getAgentByName(
        env.TestStateAgentNoInitial,
        `direct-false-${crypto.randomUUID()}`
      );

      await agent.insertFalsyState("false");
      const state = await agent.getState();
      expect(state).toBe(false);
    });

    it('should handle "" state injected directly into DB', async () => {
      const agent = await getAgentByName(
        env.TestStateAgentNoInitial,
        `direct-empty-${crypto.randomUUID()}`
      );

      await agent.insertFalsyState('""');
      const state = await agent.getState();
      expect(state).toBe("");
    });
  });

  describe("corrupted state recovery", () => {
    it("should recover from corrupted JSON and fall back to initialState", async () => {
      const agent = await getAgentByName(
        env.TestStateAgent,
        `corrupted-recovery-${crypto.randomUUID()}`
      );

      // Insert corrupted JSON directly
      await agent.insertCorruptedState();

      // Access state — should trigger parse error and recover
      const state = await agent.getStateAfterCorruption();

      expect(state).toEqual({
        count: 0,
        items: [],
        lastUpdated: null
      });
    });

    it("should clear corrupted state row when no initialState defined", async () => {
      const agent = await getAgentByName(
        env.TestStateAgentNoInitial,
        `corrupted-no-initial-${crypto.randomUUID()}`
      );

      // Insert corrupted JSON
      await agent.insertCorruptedState();

      // Access state — should return undefined and clear the corrupted row
      const state = await agent.getStateAfterCorruption();
      expect(state).toBeUndefined();

      // Corrupted row should be cleaned up
      const count = await agent.getStateRowCount();
      expect(count).toBe(0);
    });

    it("should persist recovered state so future reads don't hit corrupted data", async () => {
      const name = `corrupted-persist-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestStateAgent, name);

      await agent.insertCorruptedState();
      await agent.getStateAfterCorruption();

      // Get new stub — should read the recovered state, not corrupted data
      const agent2 = await getAgentByName(env.TestStateAgent, name);
      const state = await agent2.getState();

      expect(state).toEqual({
        count: 0,
        items: [],
        lastUpdated: null
      });
    });
  });

  describe("backward compatibility with legacy wasChanged rows", () => {
    it("should work when legacy wasChanged row exists alongside state row", async () => {
      const name = `legacy-compat-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestStateAgent, name);

      // Set state normally (creates only cf_state_row_id)
      await agent.updateState({
        count: 55,
        items: ["legacy"],
        lastUpdated: "compat"
      });

      // Manually add a legacy wasChanged row (simulates old SDK)
      await agent.insertLegacyWasChangedRow();

      // Verify both rows exist
      const ids = await agent.getStateRowIds();
      expect(ids).toContain("cf_state_row_id");
      expect(ids).toContain("cf_state_was_changed");

      // Get new stub — state should still be readable
      const agent2 = await getAgentByName(env.TestStateAgent, name);
      const state = await agent2.getState();
      expect(state).toEqual({
        count: 55,
        items: ["legacy"],
        lastUpdated: "compat"
      });
    });

    it("should clean up wasChanged on next schema migration", async () => {
      const name = `legacy-cleanup-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestStateAgent, name);

      await agent.updateState({
        count: 1,
        items: [],
        lastUpdated: null
      });
      await agent.insertLegacyWasChangedRow();

      // Reset version so _ensureSchema() enters the migration block
      await agent.resetSchemaVersion();
      await agent.runSchemaMigration();

      const ids = await agent.getStateRowIds();
      expect(ids).not.toContain("cf_state_was_changed");
      expect(ids).toContain("cf_state_row_id");

      // State preserved
      const state = await agent.getState();
      expect(state).toEqual({
        count: 1,
        items: [],
        lastUpdated: null
      });
    });
  });

  describe("orphaned legacy rows", () => {
    it("should fall back to initialState when wasChanged exists but state row was deleted", async () => {
      const agent = await getAgentByName(
        env.TestStateAgent,
        `orphan-waschanged-${crypto.randomUUID()}`
      );

      // Simulate: old SDK crashed during corruption recovery, deleting
      // STATE_ROW_ID but leaving STATE_WAS_CHANGED behind.
      await agent.insertOrphanedWasChanged();

      // State getter should not find STATE_ROW_ID, fall through to initialState
      const state = await agent.getState();
      expect(state).toEqual({
        count: 0,
        items: [],
        lastUpdated: null
      });
    });

    it("should return undefined when wasChanged exists but state row was deleted (no initialState)", async () => {
      const agent = await getAgentByName(
        env.TestStateAgentNoInitial,
        `orphan-waschanged-no-initial-${crypto.randomUUID()}`
      );

      await agent.insertOrphanedWasChanged();

      const state = await agent.getState();
      expect(state).toBeUndefined();
    });

    it("should clean up orphaned wasChanged on next migration", async () => {
      const agent = await getAgentByName(
        env.TestStateAgentNoInitial,
        `orphan-cleanup-${crypto.randomUUID()}`
      );

      await agent.insertOrphanedWasChanged();

      // Verify the orphan exists
      const idsBefore = await agent.getStateRowIds();
      expect(idsBefore).toContain("cf_state_was_changed");
      expect(idsBefore).not.toContain("cf_state_row_id");

      // Migration cleans up the orphan
      await agent.resetSchemaVersion();
      await agent.runSchemaMigration();

      const idsAfter = await agent.getStateRowIds();
      expect(idsAfter).not.toContain("cf_state_was_changed");
    });

    it("should read state correctly when state row exists without wasChanged", async () => {
      const agent = await getAgentByName(
        env.TestStateAgentNoInitial,
        `state-no-waschanged-${crypto.randomUUID()}`
      );

      // Simulate: old SDK version that only wrote STATE_ROW_ID (before
      // wasChanged was added), or crash between the two writes.
      await agent.insertStateRowWithoutWasChanged('{"key":"value"}');

      const state = await agent.getState();
      expect(state).toEqual({ key: "value" });
    });
  });

  describe("state persistence", () => {
    it("should persist complex nested state", async () => {
      const name = `complex-state-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestStateAgent, name);

      const complexState = {
        count: 42,
        items: ["a", "b", "c", "d"],
        lastUpdated: "2024-12-31T23:59:59Z"
      };
      await agent.updateState(complexState);

      const state = await agent.getState();
      expect(state).toEqual(complexState);

      // Verify only one state row
      expect(await agent.getStateRowCount()).toBe(1);
    });

    it("should handle multiple sequential state updates with single row", async () => {
      const name = `sequential-updates-${crypto.randomUUID()}`;
      const agent = await getAgentByName(env.TestStateAgent, name);

      // Update state several times
      for (let i = 0; i < 5; i++) {
        await agent.updateState({
          count: i,
          items: [`item-${i}`],
          lastUpdated: `update-${i}`
        });
      }

      // Still only 1 row in state table
      expect(await agent.getStateRowCount()).toBe(1);

      // Last update is the persisted one
      const state = await agent.getState();
      expect(state).toEqual({
        count: 4,
        items: ["item-4"],
        lastUpdated: "update-4"
      });
    });
  });
});
