import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  StateMachine,
  defineGate,
  defineMachine,
  type MachineDefinition,
  type MachineEffectOutcome,
  type MachineEffectRef,
  type MachineJson,
  type MachineListOptions,
  type MachineRunSnapshot
} from "../state-machine";

// A wrapped runtime parks between passes holding the effect it planned, so an
// effect handle has to be storable in a checkpoint. This fails if
// `MachineEffectRef` is ever declared as an interface again, because an
// interface has no implicit index signature.
declare const effectRef: MachineEffectRef<{ done: boolean }>;
const checkpointed: { readonly [key: string]: MachineJson } = {
  effect: effectRef
};
checkpointed satisfies object;

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
      const gate = context.gates.create(
        Permission,
        { tool: "exec" },
        { expiresAt: Date.now() + 1_000 }
      );
      gate.id satisfies string;
      return context.transition({ phase: "second", value: state.value });
    },
    second: async (state, context) => {
      state.phase satisfies "second";
      const outcome = await context.effects.run<{ value: string }, string>(
        "echo",
        { value: state.value },
        {
          recovery: "safe",
          timeoutMs: 1_000,
          retries: { limit: 3, delay: 100, backoff: "exponential" }
        }
      );
      outcome satisfies MachineEffectOutcome<string>;
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
object.stateMachine.notify(
  "machine_1",
  { type: "message", key: "inbox", value: "hello" },
  { eventId: "event_1" }
);
const listOptions = {
  definition: "example",
  status: ["running", "waiting"],
  limit: 1
} as const satisfies MachineListOptions;
object.stateMachine.list(listOptions) satisfies Promise<
  MachineRunSnapshot<State, { output: string }>[]
>;
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
