import { DurableObject } from "cloudflare:workers";
import {
  StateMachineHarness,
  type AgentHarness,
  type HarnessStreams
} from "../harness";
import { Lifecycle } from "../lifecycle";
import {
  StateMachine,
  defineMachine,
  type MachineDefinition,
  type MachineRunSnapshot,
  type MachineNotifyReceipt
} from "../state-machine";

type State = { phase: "waiting"; key: string };
type Event = { type: "input"; key: string; value: string };

const definition = defineMachine<State, string, { key: string }, Event>({
  version: 1,
  initial: (input) => ({ phase: "waiting", key: input.key }),
  phases: {
    waiting: (state, context) => {
      const event = context.events.take({ type: "input", key: state.key });
      return event
        ? context.complete(event.event.value)
        : context.wait(state, { type: "input", key: state.key });
    }
  }
} satisfies MachineDefinition<State, string, { key: string }, Event>);

class HarnessObject extends DurableObject {
  readonly machines = new StateMachine({
    definitions: { example: definition }
  });
  readonly harness = new StateMachineHarness({
    stateMachine: this.machines,
    definition: "example"
  });
  readonly lifecycle = Lifecycle.install(this).use(this.machines);
}

declare const object: HarnessObject;
object.harness satisfies AgentHarness<
  { key: string },
  Event,
  MachineRunSnapshot<State, string>,
  string,
  MachineNotifyReceipt
>;

object.harness.start({ key: "one" });
// @ts-expect-error input remains definition-specific
object.harness.start({ value: "one" });
object.harness.notify(
  "machine_1",
  { type: "input", key: "one", value: "hello" },
  { eventId: "event_1" }
);
object.harness.inspect("machine_1");
object.harness.abort("machine_1");
object.harness.pause("machine_1");
object.harness.resume("machine_1");
object.harness.result("machine_1") satisfies Promise<string | null>;

const streams: HarnessStreams<{ streamId: string; cursor: number }> = {
  streams: async () => [{ streamId: "stream_1", cursor: 0 }]
};
streams satisfies HarnessStreams<{ streamId: string; cursor: number }>;
