import type { StateMachineStore } from "./store";

export const STATE_MACHINE_SCHEMA_VERSION = 2;
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
           checkpoint_json, revision, control_json, job_id, wait_kind,
           wait_type, wait_key, next_at, event_sequence, cancel_requested,
           cancel_reason, result_json, error_name, error_message, retain,
           idempotency_key,
           created_at, updated_at, settled_at)
          SELECT run_id, definition, definition_version, status, phase,
                 checkpoint_json, revision, control_json, job_id, NULL,
                 NULL, NULL, NULL, 0, 0, NULL, result_json, error_name,
                 error_message, retain, idempotency_key, created_at,
                 updated_at, settled_at
          FROM cf_agents_state_machine_runs_v1`);
        store.sql("DROP TABLE cf_agents_state_machine_runs_v1");
      });
    }
    store.ensureCoordinationTables();
  }
}
