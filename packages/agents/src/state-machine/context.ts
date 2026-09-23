import type { MachineChildManager } from "./children";
import type { MachineEffectManager, PendingEffect } from "./effects";
import type { MachineEventManager } from "./events";
import type { MachineGateManager, PendingGate } from "./gates";
import type {
  GateKind,
  MachineChildRef,
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
  MachineSpawnOptions,
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
  children: MachineChildManager;
  errorSummary: (error: unknown) => { name: string; message: string };
  flushPending: (pending: PendingChanges) => void;
}): {
  context: MachineContext<MachinePhased, MachineValue>;
  pending: PendingChanges;
} {
  const {
    row,
    wake,
    events,
    gates,
    effects,
    children,
    errorSummary,
    flushPending
  } = options;
  const pending: PendingChanges = {
    claimedEventIds: [],
    gates: [],
    effects: []
  };
  let gateOrdinal = 0;
  let effectOrdinal = 0;
  let childOrdinal = 0;
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
        gates.create(
          row,
          pending.gates,
          gateOrdinal++,
          kind,
          request,
          gateOptions
        ),
      take: <Answer extends MachineJson>(gate: MachineGateRef<Answer>) =>
        gates.take(gate, (type, key) => takeEvent({ type, key }))
    }),
    effects: Object.freeze({
      plan: <Input extends MachineJson, Output extends MachineValue>(
        kind: string,
        input: Input,
        effectOptions: MachineEffectPlanOptions
      ): MachineEffectRef<Output> =>
        effects.plan(
          row,
          pending.effects,
          effectOrdinal++,
          kind,
          input,
          effectOptions
        ),
      execute: <Output extends MachineValue>(
        effect: MachineEffectRef<Output>
      ) => effects.execute(row.run_id, effect, pending.effects),
      run: async <Input extends MachineJson, Output extends MachineValue>(
        kind: string,
        input: Input,
        effectOptions: MachineEffectPlanOptions
      ) => {
        const effect = effects.plan<Input, Output>(
          row,
          pending.effects,
          effectOrdinal++,
          kind,
          input,
          effectOptions
        );
        flushPending(pending);
        return effects.execute(row.run_id, effect);
      }
    }),
    children: Object.freeze({
      spawn: <Output extends MachineValue = MachineValue>(
        definitionName: string,
        input: MachineValue,
        spawnOptions: MachineSpawnOptions = {}
      ): MachineChildRef<Output> =>
        children.spawn(
          row,
          pending.effects,
          effects,
          effectOrdinal++,
          childOrdinal++,
          definitionName,
          input,
          spawnOptions
        ),
      join: <Output extends MachineValue>(child: MachineChildRef<Output>) =>
        children.join<Output>(row.run_id, effects, child, (type, key) =>
          takeEvent({ type, key })
        )
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
