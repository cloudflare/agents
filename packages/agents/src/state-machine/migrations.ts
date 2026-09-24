import type { StateMachineStore } from "./store";

export const STATE_MACHINE_SCHEMA_VERSION = 5;
export const STATE_MACHINE_SCHEMA_VERSION_KEY =
  "cf_agents_state_machine_schema_version";

export function migrateStateMachineSchema(
  store: StateMachineStore,
  fromVersion: number
): void {
  if (fromVersion === 0) {
    store.ensureTables();
    return;
  }

  if (fromVersion < 2) {
    const columns = store.sql<{ name: string }>(
      "PRAGMA table_info(cf_agents_state_machine_runs)"
    );
    if (!columns.some((column) => column.name === "wait_kind")) {
      store.transaction(() => {
        store.sql("DROP INDEX IF EXISTS cf_agents_state_machine_definition");
        store.sql(
          "ALTER TABLE cf_agents_state_machine_runs RENAME TO cf_agents_state_machine_runs_v1"
        );
        store.createRunTable();
        store.sql(`INSERT INTO cf_agents_state_machine_runs
          (run_id, definition, definition_version, status, phase,
           checkpoint_json, revision, builder_revision, control_json, job_id, wait_kind,
           wait_type, wait_key, next_at, event_sequence, cancel_requested,
           cancel_reason, result_json, error_name, error_message, persist,
           idempotency_key,
           created_at, updated_at, settled_at)
          SELECT run_id, definition, definition_version, status, phase,
                 checkpoint_json, revision, 0, control_json, job_id, NULL,
                 NULL, NULL, NULL, 0, 0, NULL, result_json, error_name,
                 error_message, persist, idempotency_key, created_at,
                 updated_at, settled_at
          FROM cf_agents_state_machine_runs_v1`);
        store.sql("DROP TABLE cf_agents_state_machine_runs_v1");
      });
    }
    store.ensureCoordinationTables();
  }

  if (fromVersion < 3) {
    store.ensureCoordinationTables();
    const columns = store.sql<{ name: string }>(
      "PRAGMA table_info(cf_agents_state_machine_effects)"
    );
    if (!columns.some((column) => column.name === "attempt")) {
      store.sql(
        "ALTER TABLE cf_agents_state_machine_effects ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1"
      );
    }
  }

  if (fromVersion < 4) {
    const runColumns = store.sql<{ name: string }>(
      "PRAGMA table_info(cf_agents_state_machine_runs)"
    );
    if (!runColumns.some((column) => column.name === "builder_revision")) {
      store.sql(
        "ALTER TABLE cf_agents_state_machine_runs ADD COLUMN builder_revision INTEGER NOT NULL DEFAULT 0"
      );
    }
    store.transaction(() => {
      store.sql(
        "ALTER TABLE cf_agents_state_machine_effects RENAME TO cf_agents_state_machine_effects_v3"
      );
      store.createEffectTable();
      store.sql(`INSERT INTO cf_agents_state_machine_effects
        (run_id, effect_id, revision, kind, recovery, status, input_json,
         external_id, result_json, error_name, error_message, attempt,
         retry_at, options_json, created_at, settled_at)
        SELECT run_id, effect_id, revision, kind, recovery, status, input_json,
               external_id, result_json, error_name, error_message, attempt,
               NULL, '{}', created_at, settled_at
        FROM cf_agents_state_machine_effects_v3`);
      store.sql("DROP TABLE cf_agents_state_machine_effects_v3");
    });
  }

  if (fromVersion < 5) {
    // Make sure the effect table exists before rewriting it: a database that
    // skipped the v4 step reaches here with no coordination tables at all.
    store.ensureCoordinationTables();
    // An existing database may already hold duplicate external ids, which a
    // unique index would refuse to build. Those rows predate the constraint,
    // so keep the newest claimant per (run_id, external_id) and null the
    // earlier ones: nulls are exempt from the index, and an effect whose
    // external id is cleared simply loses reconcile lookup rather than
    // blocking the migration. Settled rows are never reconciled against, so
    // in practice this only rewrites history that is already inert.
    //
    // Drop the index first. `ensureCoordinationTables()` creates it as part of
    // the current effect-table DDL, so an earlier step in this same migration
    // may already have built it over rows this step still has to clean up —
    // and on that path the duplicates would have failed the index build. The
    // deduplicating UPDATE has to run against an unindexed table.
    store.transaction(() => {
      store.sql(
        "DROP INDEX IF EXISTS cf_agents_state_machine_effect_external_id"
      );
      store.sql(`UPDATE cf_agents_state_machine_effects
        SET external_id = NULL
        WHERE external_id IS NOT NULL
          AND (run_id, effect_id) NOT IN (
            SELECT run_id, effect_id FROM (
              SELECT run_id, effect_id,
                     ROW_NUMBER() OVER (
                       PARTITION BY run_id, external_id
                       ORDER BY created_at DESC, effect_id DESC
                     ) AS rn
              FROM cf_agents_state_machine_effects
              WHERE external_id IS NOT NULL
            ) WHERE rn = 1
          )`);
      store.createEffectExternalIdIndex();
    });
  }
}
