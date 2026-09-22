import { randomAlphanumeric } from "./ids";
import { serializeMachineValue } from "./serialization";
import type { StateMachineStore } from "./store";
import type { MachineEventManager } from "./events";
import { TERMINAL_STATUSES } from "./events";
import type {
  MachineChildMode,
  MachineChildRef,
  MachineChildResult,
  MachineDecision,
  MachineEvent,
  MachinePhased,
  MachineQueuedEvent,
  MachineRunRow,
  MachineSpawnOptions,
  MachineValue
} from "./types";

const MAX_ACTIVE_CHILDREN = 100;

export type PendingChild = {
  runId: string;
  definition: string;
  definitionVersion: number;
  checkpoint: string | null;
  phase: string;
  mode: MachineChildMode;
};

type ChildDefinition = {
  version: number;
  initial: (input: MachineValue) => MachinePhased;
  phases: Record<string, unknown>;
};

type InsertRun = (input: {
  runId: string;
  definition: string;
  definitionVersion: number;
  phase: string;
  checkpoint: string | null;
  retain: boolean;
  now: number;
}) => void;

export class MachineChildManager {
  readonly #store: StateMachineStore;
  readonly #events: MachineEventManager;
  readonly #definition: (name: string) => ChildDefinition;
  readonly #assertState: (
    name: string,
    definition: ChildDefinition,
    state: MachinePhased
  ) => void;
  readonly #insertRun: InsertRun;
  readonly #pushJob: (runId: string, revision: number, time: number) => void;
  readonly #emit: (type: string, payload: unknown) => void;

  constructor(options: {
    store: StateMachineStore;
    events: MachineEventManager;
    definition: (name: string) => ChildDefinition;
    assertState: (
      name: string,
      definition: ChildDefinition,
      state: MachinePhased
    ) => void;
    insertRun: InsertRun;
    pushJob: (runId: string, revision: number, time: number) => void;
    emit: (type: string, payload: unknown) => void;
  }) {
    this.#store = options.store;
    this.#events = options.events;
    this.#definition = options.definition;
    this.#assertState = options.assertState;
    this.#insertRun = options.insertRun;
    this.#pushJob = options.pushJob;
    this.#emit = options.emit;
  }

  spawn<Output extends MachineValue = MachineValue>(
    row: MachineRunRow,
    pending: PendingChild[],
    definitionName: string,
    input: MachineValue,
    options: MachineSpawnOptions = {}
  ): MachineChildRef<Output> {
    const activeChildren = this.#store
      .childrenForRun(row.run_id)
      .filter((child) => child.status === "running").length;
    if (activeChildren + pending.length >= MAX_ACTIVE_CHILDREN) {
      throw new Error(
        `Machine run "${row.run_id}" has too many active children`
      );
    }
    const definition = this.#definition(definitionName);
    const state = definition.initial(input);
    this.#assertState(definitionName, definition, state);
    const runId = options.runId ?? `machine_${randomAlphanumeric()}`;
    pending.push({
      runId,
      definition: definitionName,
      definitionVersion: definition.version,
      checkpoint: serializeMachineValue(
        state,
        `checkpoint for child Machine "${definitionName}"`
      ),
      phase: state.phase,
      mode: options.mode ?? "attached"
    });
    return {
      runId,
      definition: definitionName,
      mode: options.mode ?? "attached"
    };
  }

  take<Output extends MachineValue>(
    child: MachineChildRef<Output>,
    takeEvent: (type: string, key: string) => MachineQueuedEvent | null
  ): MachineChildResult<Output> | null {
    const queued = takeEvent("state-machine:child-completed", child.runId);
    if (!queued) return null;
    const event = queued.event as MachineEvent & {
      ok: boolean;
      output?: Output;
      error?: { name: string; message: string };
    };
    return event.ok
      ? { ok: true, output: event.output as Output }
      : {
          ok: false,
          error: event.error ?? {
            name: "Error",
            message: "Child Machine failed"
          }
        };
  }

  applyPending(
    parentRunId: string,
    pending: readonly PendingChild[],
    now: number
  ): void {
    for (const child of pending) {
      this.#insertRun({
        runId: child.runId,
        definition: child.definition,
        definitionVersion: child.definitionVersion,
        phase: child.phase,
        checkpoint: child.checkpoint,
        retain: true,
        now
      });
      this.#store.sql(
        `INSERT INTO cf_agents_state_machine_children
          (parent_run_id, child_run_id, child_definition, mode, status,
           completion_event_id, created_at, settled_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, NULL)`,
        parentRunId,
        child.runId,
        child.definition,
        child.mode,
        `child_${child.runId}`,
        now
      );
      this.#pushJob(child.runId, 0, now);
    }
  }

  publishPending(parentRunId: string, pending: readonly PendingChild[]): void {
    for (const child of pending) {
      this.#emit("state-machine:child:spawned", {
        runId: parentRunId,
        childRunId: child.runId,
        definition: child.definition,
        mode: child.mode
      });
    }
  }

  settleParentRelations(
    row: MachineRunRow,
    decision: Extract<
      MachineDecision<MachinePhased, MachineValue>,
      { kind: "complete" | "fail" }
    >,
    now: number
  ): void {
    for (const relation of this.#store.parentRelations(row.run_id)) {
      this.#store.write(
        `UPDATE cf_agents_state_machine_children
         SET status = ?, settled_at = ?
         WHERE parent_run_id = ? AND child_run_id = ? AND status = 'running'`,
        [
          decision.kind === "complete" ? "completed" : "failed",
          now,
          relation.parent_run_id,
          row.run_id
        ]
      );
      const parent = this.#store.getRun(relation.parent_run_id);
      if (!parent || TERMINAL_STATUSES.has(parent.status)) continue;
      const event: MachineEvent =
        decision.kind === "complete"
          ? {
              type: "state-machine:child-completed",
              key: row.run_id,
              childRunId: row.run_id,
              ok: true,
              output: decision.result as
                | import("./types").MachineJson
                | undefined
            }
          : {
              type: "state-machine:child-completed",
              key: row.run_id,
              childRunId: row.run_id,
              ok: false,
              error: decision.error
            };
      this.#events.insert(
        parent,
        relation.completion_event_id,
        event,
        now,
        undefined
      );
      this.#events.wakeWaitingRun(parent, event, now);
    }
  }

  cascadeAttachedCancellation(
    parentRunId: string,
    reason: string | undefined,
    now: number
  ): void {
    for (const child of this.#store.childrenForRun(parentRunId)) {
      if (child.mode !== "attached" || child.status !== "running") continue;
      this.#store.write(
        `UPDATE cf_agents_state_machine_runs
         SET cancel_requested = 1, cancel_reason = ?, status = 'running',
             updated_at = ?
         WHERE run_id = ? AND status IN ('running', 'waiting', 'paused')`,
        [reason ?? "parent cancelled", now, child.child_run_id]
      );
      const childRow = this.#store.getRun(child.child_run_id);
      if (childRow) this.#pushJob(childRow.run_id, childRow.revision, now);
    }
  }

  settleCancelledRelations(
    row: MachineRunRow,
    reason: string | undefined,
    now: number
  ): void {
    for (const relation of this.#store.parentRelations(row.run_id)) {
      const relationSettled = this.#store.write(
        `UPDATE cf_agents_state_machine_children
         SET status = 'cancelled', settled_at = ?
         WHERE parent_run_id = ? AND child_run_id = ? AND status = 'running'`,
        [now, relation.parent_run_id, row.run_id]
      );
      if (relationSettled === 0) continue;
      const parent = this.#store.getRun(relation.parent_run_id);
      if (!parent || TERMINAL_STATUSES.has(parent.status)) continue;
      const event: MachineEvent = {
        type: "state-machine:child-completed",
        key: row.run_id,
        childRunId: row.run_id,
        ok: false,
        error: { name: "Cancelled", message: reason ?? "Child cancelled" }
      };
      this.#events.insert(
        parent,
        relation.completion_event_id,
        event,
        now,
        undefined
      );
      this.#events.wakeWaitingRun(parent, event, now);
    }
  }
}
