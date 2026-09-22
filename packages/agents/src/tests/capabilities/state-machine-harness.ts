import { DurableObject } from "cloudflare:workers";
import { StateMachineHarness } from "../../harness";
import { Lifecycle } from "../../lifecycle";
import {
  StateMachine,
  defineMachine,
  type MachineDefinition
} from "../../state-machine";
import type { TestHarnessSnapshot } from "./harness-shared";

type TestHarnessEvent = {
  type: "message";
  key: string;
  value: string;
};

type TestHarnessState = {
  phase: "waiting";
  key: string;
  timeoutAt: number;
};

const definition = defineMachine<
  TestHarnessState,
  string,
  { key: string; timeoutMs: number },
  TestHarnessEvent
>({
  version: 1,
  initial: (input) => ({
    phase: "waiting",
    key: input.key,
    timeoutAt: Date.now() + input.timeoutMs
  }),
  phases: {
    waiting: (state, context) => {
      const queued = context.events.take({
        type: "message",
        key: state.key
      });
      if (queued) return context.complete(queued.event.value);
      if (context.wake.kind === "timeout") {
        return context.complete("timed-out");
      }
      return context.wait(state, {
        type: "message",
        key: state.key,
        timeoutAt: state.timeoutAt
      });
    }
  }
} satisfies MachineDefinition<
  TestHarnessState,
  string,
  { key: string; timeoutMs: number },
  TestHarnessEvent
>);

export class StateMachineAdapterHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly #machines = new StateMachine({
    definitions: { harness: definition }
  });
  readonly #harness = new StateMachineHarness({
    stateMachine: this.#machines,
    definition: "harness"
  });
  readonly lifecycle = Lifecycle.install(this).use(this.#machines);

  start(key: string, options?: { runId?: string; idempotencyKey?: string }) {
    return this.#harness.start({ key, timeoutMs: 60_000 }, options);
  }

  notify(runId: string, key: string, value: string, eventId: string) {
    return this.#harness.notify(
      runId,
      { type: "message", key, value },
      { eventId }
    );
  }

  async inspect(runId: string): Promise<TestHarnessSnapshot | null> {
    return (await this.#harness.inspect(
      runId
    )) as unknown as TestHarnessSnapshot | null;
  }

  abort(runId: string, reason?: string) {
    return this.#harness.abort(runId, reason);
  }

  pause(runId: string) {
    return this.#harness.pause(runId);
  }

  resume(runId: string) {
    return this.#harness.resume(runId);
  }

  result(runId: string) {
    return this.#harness.result(runId);
  }
}
