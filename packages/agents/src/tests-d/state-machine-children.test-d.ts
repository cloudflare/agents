import {
  defineMachine,
  type MachineChildMode,
  type MachineChildRef,
  type MachineSpawnOptions
} from "../state-machine";

type State = { phase: "only"; value: string };

const modes: MachineChildMode[] = ["attached", "background"];
modes satisfies readonly MachineChildMode[];

// @ts-expect-error - detached children are not part of StateMachine.
const detached: MachineChildMode = "detached";
void detached;

const attached: MachineSpawnOptions = { mode: "attached" };
const background: MachineSpawnOptions = {
  mode: "background",
  runId: "background-child"
};
attached satisfies MachineSpawnOptions;
background satisfies MachineSpawnOptions;

declare const childRef: MachineChildRef<string>;
childRef.runId satisfies string;
childRef.mode satisfies MachineChildMode;
childRef.effect.id satisfies string;

const parent = defineMachine<State, { done: true }, { value: string }>({
  version: 1,
  initial: (input) => ({ phase: "only", value: input.value }),
  phases: {
    only: async (state, context) => {
      const child = context.children.spawn<string>("child", {
        value: state.value
      });
      const result = await context.children.join(child);
      if (result?.ok) result.output satisfies string;
      return context.complete({ done: true });
    }
  }
});
void parent;
