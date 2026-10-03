import { Driver } from "../../driver";
import type {
  DriverHandle,
  DriverOperation,
  DriverRegistrationOptions,
  DriverRuntime,
  DriverStep
} from "../../driver";
import type { CapabilityHarness } from "../shared/capability-harness";

export type Input = { text: string };
export type Result = { answer: string };

type Answer =
  | DriverStep<Result>
  | ((
      operation: DriverOperation<Input>,
      signal: AbortSignal
    ) => Promise<DriverStep<Result>>);

/**
 * A runtime whose steps answer from a script, one entry per call, and
 * record every call. An empty script parks.
 */
export class ScriptedRuntime implements DriverRuntime<Input, Result> {
  readonly script: Answer[] = [];
  readonly calls: string[] = [];
  readonly operations: DriverOperation<Input>[] = [];
  stopAnswer: (() => Promise<void>) | undefined;

  answer(...answers: Answer[]): this {
    this.script.push(...answers);
    return this;
  }

  async step(
    operation: DriverOperation<Input>,
    signal: AbortSignal
  ): Promise<DriverStep<Result>> {
    this.calls.push(`step:${operation.id}`);
    this.operations.push(operation);
    const next = this.script.shift() ?? { then: "park" };
    return typeof next === "function" ? next(operation, signal) : next;
  }

  async stop(operation: DriverOperation<Input>): Promise<void> {
    this.calls.push(`stop:${operation.id}`);
    await this.stopAnswer?.();
  }
}

export async function setup(
  harness: CapabilityHarness,
  runtime: DriverRuntime<Input, Result> = new ScriptedRuntime(),
  options: DriverRegistrationOptions<Input> = {}
) {
  const capability = new Driver();
  const driver: DriverHandle<Input> = capability.register<Input, Result>(
    "test",
    runtime,
    options
  );
  const { lifecycle } = harness.install(capability);
  await lifecycle.start();

  /** Run the scope's job once, as the alarm would, and wait for its step. */
  async function cycle(scope = "main") {
    const job = capability
      .jobs()
      .find(
        (candidate) => (candidate.payload as { scope: string }).scope === scope
      );
    if (!job) throw new Error(`No job for scope ${scope}`);
    await capability.onJob({ job, attempt: 1 });
    await driver.waitForIdle(scope);
    await harness.storage.deleteAlarm();
  }

  /** The scope's job time, or undefined when it holds no job. */
  function jobTime(scope = "main") {
    return capability
      .jobs()
      .find(
        (candidate) => (candidate.payload as { scope: string }).scope === scope
      )?.time;
  }

  async function submit(id: string, scope = "main") {
    const receipt = await driver.submit(scope, { text: id }, { id });
    await harness.storage.deleteAlarm();
    return receipt;
  }

  return { capability, driver, cycle, jobTime, submit };
}

/** A promise with its resolver, for holding a step open. */
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
