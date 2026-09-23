import { effectPending } from "./effect";
import type { MachineEffectManager, PendingEffect } from "./effects";
import { machineBuilderId } from "./ids";
import {
  deserializeMachineValue,
  serializeMachineValue
} from "./serialization";
import type { StateMachineStore } from "./store";
import type { MachineEventManager } from "./events";
import { TERMINAL_STATUSES } from "./events";
import type {
  MachineChildMode,
  MachineChildRef,
  MachineChildResult,
  MachineDecision,
  MachineEffectInvocation,
  MachineEffectRuntimes,
  MachineEvent,
  MachineJson,
  MachinePhased,
  MachineQueuedEvent,
  MachineRunRow,
  MachineSpawnOptions,
  MachineValue
} from "./types";

export const ATTACHED_CHILD_EFFECT = "__cf_state_machine_child_attached";
export const BACKGROUND_CHILD_EFFECT = "__cf_state_machine_child_background";

const MAX_ACTIVE_CHILDREN = 100;

type ChildEffectResult =
  | { ok: true; output: MachineJson; outputUndefined: boolean }
  | { ok: false; error: { name: string; message: string } };

type ChildEffectInput = {
  parentRunId: string;
  runId: string;
  definition: string;
  definitionVersion: number;
  checkpoint: string | null;
  phase: string;
  mode: MachineChildMode;
  completionEventId: string;
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
  persist: boolean;
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

  get runtimes(): MachineEffectRuntimes {
    return {
      [ATTACHED_CHILD_EFFECT]: {
        execute: (input, invocation) =>
          this.#execute(input as ChildEffectInput, invocation),
        reconcile: (runId) => this.#reconcile(runId),
        cancel: (runId) => this.#cancel(runId)
      },
      [BACKGROUND_CHILD_EFFECT]: {
        execute: (input, invocation) =>
          this.#execute(input as ChildEffectInput, invocation),
        reconcile: (runId) => this.#reconcile(runId)
      }
    };
  }

  spawn<Output extends MachineValue = MachineValue>(
    row: MachineRunRow,
    pendingEffects: PendingEffect[],
    effects: MachineEffectManager,
    effectOrdinal: number,
    childOrdinal: number,
    definitionName: string,
    input: MachineValue,
    options: MachineSpawnOptions = {}
  ): MachineChildRef<Output> {
    const activeChildren = this.#store
      .childrenForRun(row.run_id)
      .filter((child) => child.status === "running").length;
    const pendingChildren = pendingEffects.filter(
      (effect) =>
        effect.kind === ATTACHED_CHILD_EFFECT ||
        effect.kind === BACKGROUND_CHILD_EFFECT
    ).length;
    if (activeChildren + pendingChildren >= MAX_ACTIVE_CHILDREN) {
      throw new Error(
        `Machine run "${row.run_id}" has too many active children`
      );
    }

    const definition = this.#definition(definitionName);
    const state = definition.initial(input);
    this.#assertState(definitionName, definition, state);
    const runId =
      options.runId ??
      machineBuilderId(row.run_id, row.builder_revision, "child", childOrdinal);
    const mode = options.mode ?? "attached";
    const completionEventId = `child_${runId}`;
    const effect = effects.plan<ChildEffectInput, MachineJson>(
      row,
      pendingEffects,
      effectOrdinal,
      mode === "attached" ? ATTACHED_CHILD_EFFECT : BACKGROUND_CHILD_EFFECT,
      {
        parentRunId: row.run_id,
        runId,
        definition: definitionName,
        definitionVersion: definition.version,
        checkpoint: serializeMachineValue(
          state,
          `checkpoint for child Machine "${definitionName}"`
        ),
        phase: state.phase,
        mode,
        completionEventId
      },
      { recovery: "reconcile", externalId: runId }
    );

    return {
      runId,
      definition: definitionName,
      mode,
      effect
    };
  }

  async join<Output extends MachineValue>(
    parentRunId: string,
    effects: MachineEffectManager,
    child: MachineChildRef<Output>,
    takeEvent: (type: string, key: string) => MachineQueuedEvent | null
  ): Promise<MachineChildResult<Output> | null> {
    const outcome = await effects.execute(parentRunId, child.effect);
    if (outcome.status === "running") return null;
    if (outcome.status === "completed") {
      takeEvent("state-machine:child-completed", child.runId);
      const result = outcome.output as ChildEffectResult;
      return result.ok
        ? {
            ok: true,
            output: (result.outputUndefined
              ? undefined
              : result.output) as Output
          }
        : result;
    }
    if (outcome.status === "failed") {
      return { ok: false, error: outcome.error };
    }
    return {
      ok: false,
      error: {
        name: "Interrupted",
        message: `Child Machine ${JSON.stringify(child.runId)} was interrupted`
      }
    };
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
      const settled = this.#store.write(
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
      if (settled === 0) continue;
      const parent = this.#store.getRun(relation.parent_run_id);
      if (!parent || TERMINAL_STATUSES.has(parent.status)) continue;
      const event: MachineEvent = {
        type: "state-machine:child-completed",
        key: row.run_id,
        childRunId: row.run_id
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

  settleCancelledRelations(
    row: MachineRunRow,
    _reason: string | undefined,
    now: number
  ): void {
    for (const relation of this.#store.parentRelations(row.run_id)) {
      const settled = this.#store.write(
        `UPDATE cf_agents_state_machine_children
         SET status = 'cancelled', settled_at = ?
         WHERE parent_run_id = ? AND child_run_id = ? AND status = 'running'`,
        [now, relation.parent_run_id, row.run_id]
      );
      if (settled === 0) continue;
      const parent = this.#store.getRun(relation.parent_run_id);
      if (!parent || TERMINAL_STATUSES.has(parent.status)) continue;
      const event: MachineEvent = {
        type: "state-machine:child-completed",
        key: row.run_id,
        childRunId: row.run_id
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

  async #execute(input: ChildEffectInput, invocation: MachineEffectInvocation) {
    if (invocation.externalId !== input.runId) {
      throw new Error("Machine child effect externalId does not match runId");
    }

    const now = Date.now();
    this.#store.transaction(() => {
      const existing = this.#store.getRun(input.runId);
      if (existing) {
        if (existing.definition !== input.definition) {
          throw new Error(
            `Machine run ${JSON.stringify(input.runId)} belongs to ${JSON.stringify(existing.definition)}`
          );
        }
      } else {
        this.#insertRun({
          runId: input.runId,
          definition: input.definition,
          definitionVersion: input.definitionVersion,
          phase: input.phase,
          checkpoint: input.checkpoint,
          persist: true,
          now
        });
        this.#pushJob(input.runId, 0, now);
      }
      this.#store.sql(
        `INSERT OR IGNORE INTO cf_agents_state_machine_children
          (parent_run_id, child_run_id, child_definition, mode, status,
           completion_event_id, created_at, settled_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, NULL)`,
        input.parentRunId,
        input.runId,
        input.definition,
        input.mode,
        input.completionEventId,
        now
      );
    });
    this.#emit("state-machine:child:spawned", {
      runId: input.parentRunId,
      childRunId: input.runId,
      definition: input.definition,
      mode: input.mode
    });
    return effectPending(input.runId);
  }

  async #reconcile(
    runId: string
  ): Promise<
    { status: "running" } | { status: "completed"; output: ChildEffectResult }
  > {
    const row = this.#store.getRun(runId);
    if (!row || !TERMINAL_STATUSES.has(row.status)) {
      return { status: "running" };
    }
    if (row.status === "completed") {
      const output = deserializeMachineValue(row.result_json);
      return {
        status: "completed",
        output: {
          ok: true,
          output: output === undefined ? null : (output as MachineJson),
          outputUndefined: output === undefined
        }
      };
    }
    return {
      status: "completed",
      output: {
        ok: false,
        error: {
          name:
            row.error_name ??
            (row.status === "cancelled" ? "Cancelled" : "Error"),
          message:
            row.error_message ??
            (row.status === "cancelled"
              ? "Child Machine cancelled"
              : "Child Machine failed")
        }
      }
    };
  }

  async #cancel(runId: string): Promise<void> {
    const row = this.#store.getRun(runId);
    if (!row || TERMINAL_STATUSES.has(row.status)) return;
    const now = Date.now();
    this.#store.transaction(() => {
      this.#store.write(
        `UPDATE cf_agents_state_machine_runs
         SET cancel_requested = 1, cancel_reason = 'parent cancelled',
             status = 'running', updated_at = ?
         WHERE run_id = ? AND status IN ('running', 'waiting', 'paused')`,
        [now, runId]
      );
      this.#pushJob(runId, row.revision, now);
    });
  }
}
