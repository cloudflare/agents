import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  StateMachine,
  defineGate,
  defineMachine,
  type MachineDefinition,
  type MachineRunSnapshot
} from "../state-machine";

type State =
  | { phase: "first"; value: string }
  | { phase: "second"; value: string };

type ExampleEvent =
  | { type: "message"; key: string; value: string }
  | { type: "stop"; reason: string };

const Permission = defineGate<{ tool: string }, { approved: boolean }>(
  "permission"
);
Permission.name satisfies string;

const example = defineMachine<
  State,
  { output: string },
  { value: string },
  ExampleEvent
>({
  version: 1,
  initial: (input) => ({ phase: "first", value: input.value }),
  phases: {
    first: (state, context) => {
      state.phase satisfies "first";
      const message = context.events.take({ type: "message" });
      if (message) message.event.value satisfies string;
      const gate = context.gates.open(
        Permission,
        { tool: "exec" },
        { expiresAt: Date.now() + 1_000 }
      );
      gate.id satisfies string;
      return context.transition({ phase: "second", value: state.value });
    },
    second: (state, context) => {
      state.phase satisfies "second";
      return context.complete({ output: state.value });
    }
  }
} satisfies MachineDefinition<
  State,
  { output: string },
  { value: string },
  ExampleEvent
>);

class ExampleObject extends DurableObject {
  readonly stateMachine = new StateMachine({
    definitions: { example }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.stateMachine);
}

declare const object: ExampleObject;
object.stateMachine satisfies DurableObjectCapability;
object.stateMachine.run("example", { value: "ok" });
object.stateMachine.send(
  "machine_1",
  { type: "message", key: "inbox", value: "hello" },
  { eventId: "event_1" }
);
object.stateMachine.cancel("machine_1");
object.stateMachine.pause("machine_1");
object.stateMachine.resume("machine_1");
// @ts-expect-error wrong input shape
object.stateMachine.run("example", { label: "no" });
// @ts-expect-error unknown machine definition
object.stateMachine.run("missing", { value: "no" });

object.stateMachine.get(
  "machine_1",
  "example"
) satisfies Promise<MachineRunSnapshot<State, { output: string }> | null>;
