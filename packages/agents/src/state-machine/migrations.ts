import type { StateMachineStore } from "./store";

export const STATE_MACHINE_SCHEMA_VERSION = 1;
export const STATE_MACHINE_SCHEMA_VERSION_KEY =
  "cf_agents_state_machine_schema_version";

export function migrateStateMachineSchema(store: StateMachineStore): void {
  store.ensureTables();
}
