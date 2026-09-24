import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../lifecycle";
import {
  OpenCodeHarness,
  type OpenCodeHarnessConfig,
  type OpenCodeRequest,
  type OpenCodeResult
} from "../opencode";
import { Streams } from "../streams";

declare const config: Omit<OpenCodeHarnessConfig, "streams">;

class OpenCodeObject extends DurableObject {
  readonly streams = new Streams();
  readonly harness = new OpenCodeHarness({ ...config, streams: this.streams });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.harness.driver)
    .use(this.harness);
}

declare const object: OpenCodeObject;
declare const request: OpenCodeRequest;
object.harness.submit(request) satisfies Promise<{
  operationId: string;
  sessionId: string;
  accepted: boolean;
}>;
object.harness.waitForResult("operation") satisfies Promise<OpenCodeResult>;
