import { DurableObject } from "cloudflare:workers";
import {
  Driver,
  DurableToolRuns,
  type DriverHandle,
  type DriverRuntime,
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

// A harness receives the host's driver and registers itself as a runtime.
class EchoHarness
  extends LifecycleCapability
  implements DriverRuntime<Input, Result>
{
  readonly #driver: DriverHandle<Input>;

  constructor(options: { driver: Driver }) {
    super("echo");
    this.#driver = options.driver.register<Input, Result>("echo", this, {
      settle: (submission, result) => {
        submission.operationId satisfies string;
        result.answer satisfies string;
      }
    });
  }

  send(text: string) {
    return this.#driver.submit("main", { text });
  }

  wake(scope: string) {
    return this.#driver.wake(scope);
  }

  async inspect() {
    return { status: "not-admitted" } as const;
  }
  async admit() {}
  async drive() {
    return { status: "waiting" } as const;
  }
  async cancel() {
    return { status: "cancelled" } as const;
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
  operationId: string;
  scope: string;
  accepted: boolean;
  submittedAt: number;
}>;

declare const handle: DriverHandle<Input>;
handle.pending("main") satisfies Promise<
  Array<{
    runtimeId: string;
    operationId: string;
    scope: string;
    input: Input;
  }>
>;

declare const driver: Driver;
const typed = driver.register<Input, Result>("typed", {} as EchoHarness);
// @ts-expect-error the input must match the runtime's input type
typed.submit("main", { wrong: true });
