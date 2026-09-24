import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../lifecycle";
import { OpenCodeHarness } from "../opencode";
import { Streams } from "../streams";

export class OpenCodeHarnessTestObject extends DurableObject<Cloudflare.Env> {
  readonly streams = new Streams();
  readonly harness = new OpenCodeHarness({
    streams: this.streams,
    workerd: {
      models: { fetch: false }
    }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.harness.driver)
    .use(this.harness);

  sessionId() {
    return this.harness.sessionId();
  }

  snapshot() {
    return this.harness.snapshot();
  }

  dispose() {
    return this.lifecycle.dispose();
  }
}
