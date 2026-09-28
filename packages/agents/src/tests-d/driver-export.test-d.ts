import { DurableObject } from "cloudflare:workers";
import {
  Driver,
  DurableToolRuns,
  type DriverHandle,
  type DriverOperation,
  type DriverRuntime,
  type DriverStep,
  type DurableToolRuntime
} from "../driver";
import {
  Lifecycle,
  LifecycleCapability,
  type DurableObjectCapability
} from "../lifecycle";

type Input = { text: string };
type Result = { answer: string };

declare const toolRuntime: DurableToolRuntime<Input, Result>;

// A harness receives the host's driver and registers a private runtime.
class EchoHarness extends LifecycleCapability {
  readonly #driver: DriverHandle<Input>;

  constructor(options: { driver: Driver }) {
    super("echo");
    this.#driver = options.driver.register<Input, Result>(
      "echo",
      { step: (operation, signal) => this.#step(operation, signal) },
      {
        onFail: (operation, error) => {
          operation.input.text satisfies string;
          error.message satisfies string;
        }
      }
    );
  }

  send(text: string) {
    return this.#driver.submit("main", { text });
  }

  wake(scope: string) {
    return this.#driver.wake(scope);
  }

  async #step(
    operation: DriverOperation<Input>,
    _signal: AbortSignal
  ): Promise<DriverStep<Result>> {
    if (operation.input.text === "") return { then: "park" };
    if (operation.attempt > 0) return { then: "sleep", until: Date.now() };
    return { then: "done", result: { answer: operation.input.text } };
  }
}

class DriverObject extends DurableObject {
  readonly driver = new Driver();
  readonly harness = new EchoHarness({ driver: this.driver });
  readonly tools = new DurableToolRuns({
    id: "tools",
    runtime: toolRuntime,
    wake: async (owner) => {
      owner.runtimeId satisfies string;
      await this.harness.wake(owner.scope);
    }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.driver)
    .use(this.tools)
    .use(this.harness);
}

declare const object: DriverObject;
object.driver satisfies DurableObjectCapability;
object.harness.send("hello") satisfies Promise<{
  id: string;
  scope: string;
  accepted: boolean;
  submittedAt: number;
}>;

declare const handle: DriverHandle<Input>;
handle.pending("main") satisfies Promise<
  Array<{
    runtimeId: string;
    id: string;
    scope: string;
    input: Input;
    status: "queued" | "running";
  }>
>;
handle.stop("op-1") satisfies Promise<boolean>;

declare const driver: Driver;
// `stop` is optional.
driver.register<Input, Result>("minimal", {
  step: async () => ({ then: "done", result: { answer: "ok" } })
});

declare const runtime: DriverRuntime<Input, Result>;
const typed = driver.register<Input, Result>("typed", runtime);
// @ts-expect-error the input must match the runtime's input type
typed.submit("main", { wrong: true });

driver.register<Input, Result>("bad", {
  // @ts-expect-error a step must answer continue, sleep, park or done
  step: async () => ({ then: "later" })
});
