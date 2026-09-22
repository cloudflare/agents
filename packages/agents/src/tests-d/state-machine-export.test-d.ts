import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  StateMachine,
  defineMachine,
  type MachineDefinition,
  type MachineRunSnapshot
} from "../state-machine";

type State =
  | { phase: "first"; value: string }
  | { phase: "second"; value: string };

const example = defineMachine<State, { output: string }, { value: string }>({
  version: 1,
  initial: (input) => ({ phase: "first", value: input.value }),
  phases: {
    first: (state, context) => {
      state.phase satisfies "first";
      return context.transition({ phase: "second", value: state.value });
    },
    second: (state, context) => {
      state.phase satisfies "second";
      return context.complete({ output: state.value });
    }
  }
} satisfies MachineDefinition<State, { output: string }, { value: string }>);

class ExampleObject extends DurableObject {
  readonly stateMachine = new StateMachine({
    definitions: { example }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.stateMachine);
}

declare const object: ExampleObject;
object.stateMachine satisfies DurableObjectCapability;
object.stateMachine.run("example", { value: "ok" });
// @ts-expect-error wrong input shape
object.stateMachine.run("example", { label: "no" });
// @ts-expect-error unknown machine definition
object.stateMachine.run("missing", { value: "no" });

object.stateMachine.get(
  "machine_1",
  "example"
) satisfies Promise<MachineRunSnapshot<State, { output: string }> | null>;
