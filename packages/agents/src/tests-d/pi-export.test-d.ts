import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../lifecycle";
import {
  PiHarness,
  type PiHarnessConfig,
  type PiOperationRequest,
  type PiOperationResult
} from "../pi";
import { Streams } from "../streams";

declare const config: Omit<PiHarnessConfig, "streams">;

class PiObject extends DurableObject {
  readonly streams = new Streams();
  readonly harness = new PiHarness({ ...config, streams: this.streams });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.harness.driver)
    .use(this.harness);
}

declare const object: PiObject;
declare const request: PiOperationRequest;
object.harness.submit(request, { lane: "main" }) satisfies Promise<{
  operationId: string;
  lane: string;
  accepted: boolean;
}>;
object.harness.getResult("operation", { lane: "main" }) satisfies Promise<
  PiOperationResult | undefined
>;
object.harness.pending({ lane: "main" }) satisfies Promise<
  Array<{ operationId: string; lane: string; request: PiOperationRequest }>
>;
