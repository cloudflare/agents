import { DurableObject } from "cloudflare:workers";
import {
  DurableToolRuns,
  HarnessDriver,
  type DurableToolRuntime,
  type HarnessDriverRuntime
} from "../driver";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";

type Input = { text: string };
type Result = { answer: string };

declare const runtime: HarnessDriverRuntime<Input, Result>;
declare const toolRuntime: DurableToolRuntime<Input, Result>;

class DriverObject extends DurableObject {
  readonly driver = new HarnessDriver({ id: "test", runtime });
  readonly tools = new DurableToolRuns({
    id: "tools",
    runtime: toolRuntime,
    wake: async (owner) => {
      await this.driver.wake(owner.scope);
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.driver).use(this.tools);
}

declare const object: DriverObject;
object.driver satisfies DurableObjectCapability;
object.driver.submit("main", { text: "hello" }) satisfies Promise<{
  operationId: string;
  scope: string;
  accepted: boolean;
  submittedAt: number;
}>;
object.driver.pending("main") satisfies Promise<
  Array<{
    operationId: string;
    scope: string;
    input: Input;
  }>
>;
