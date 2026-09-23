import type { MachineEffectManager, PendingEffect } from "./effects";
import type { MachineEventManager } from "./events";
import type { MachineGateManager, PendingGate } from "./gates";
import type {
  GateKind,
  MachineCommitParticipant,
  MachineContext,
  MachineEffectPlanOptions,
  MachineEffectRef,
  MachineEventFilter,
  MachineGateOptions,
  MachineGateRef,
  MachineJson,
  MachinePhased,
  MachineQueuedEvent,
  MachineRunRow,
  MachineTransitionOptions,
  MachineValue,
  MachineWaitOptions,
  MachineWake
} from "./types";

export type PendingChanges = {
  claimedEventIds: string[];
  gates: PendingGate[];
  effects: PendingEffect[];
};

export function createMachineContext(options: {
  row: MachineRunRow;
  wake: MachineWake;
  events: MachineEventManager;
  gates: MachineGateManager;
  effects: MachineEffectManager;
  errorSummary: (error: unknown) => { name: string; message: string };
}): {
  context: MachineContext<MachinePhased, MachineValue>;
  pending: PendingChanges;
} {
  const { row, wake, events, gates, effects, errorSummary } = options;
  const pending: PendingChanges = {
    claimedEventIds: [],
    gates: [],
    effects: []
  };
  const takeEvent = (filter: MachineEventFilter): MachineQueuedEvent | null =>
    events.take(row, pending.claimedEventIds, filter);
  const commit = (transition?: MachineTransitionOptions) =>
    transition?.commit ?? ([] as readonly MachineCommitParticipant[]);

  const context: MachineContext<MachinePhased, MachineValue> = Object.freeze({
    runId: row.run_id,
    revision: row.revision,
    wake,
    events: Object.freeze({
      take: <const Filter extends MachineEventFilter>(filter: Filter) =>
        takeEvent(filter) as MachineQueuedEvent<
          Extract<import("./types").MachineEvent, { type: Filter["type"] }>
        > | null
    }),
    gates: Object.freeze({
      create: <Payload extends MachineJson, Answer extends MachineJson>(
        kind: GateKind<Payload, Answer>,
        request: Payload,
        gateOptions: MachineGateOptions
      ): MachineGateRef<Answer> =>
        gates.create(row, pending.gates, kind, request, gateOptions),
      take: <Answer extends MachineJson>(gate: MachineGateRef<Answer>) =>
        gates.take(gate, (type, key) => takeEvent({ type, key }))
    }),
    effects: Object.freeze({
      plan: <Input extends MachineJson, Output extends MachineValue>(
        kind: string,
        input: Input,
        effectOptions: MachineEffectPlanOptions
      ): MachineEffectRef<Output> =>
        effects.plan(row, pending.effects, kind, input, effectOptions),
      execute: <Output extends MachineValue>(
        effect: MachineEffectRef<Output>
      ) => effects.execute(row.run_id, effect)
    }),
    transition: (
      state: MachinePhased,
      transition?: MachineTransitionOptions
    ) => ({
      kind: "transition" as const,
      state,
      commit: commit(transition)
    }),
    wait: (
      state: MachinePhased,
      wait: MachineWaitOptions,
      transition?: MachineTransitionOptions
    ) => ({ kind: "wait" as const, state, wait, commit: commit(transition) }),
    complete: (
      result: MachineValue,
      transition?: MachineTransitionOptions
    ) => ({
      kind: "complete" as const,
      result,
      commit: commit(transition)
    }),
    fail: (error: unknown, transition?: MachineTransitionOptions) => ({
      kind: "fail" as const,
      error: errorSummary(error),
      commit: commit(transition)
    })
  });
  return { context, pending };
}
