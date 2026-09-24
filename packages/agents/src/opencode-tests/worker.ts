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
    },
    resumePrompts: false
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.streams)
    .use(this.harness.driver);

  sessionId() {
    return this.harness.sessionId();
  }

  createSession() {
    return this.harness.createSession();
  }

  submitPrompt(sessionId: string, operationId: string, text: string) {
    return this.harness.submit(
      { kind: "prompt", text },
      { sessionId, operationId }
    );
  }

  messages(sessionId: string) {
    return this.harness.getMessages({ sessionId });
  }

  pending(sessionId: string) {
    return this.harness.pending({ sessionId });
  }

  snapshot(sessionId?: string) {
    return this.harness.snapshot({ sessionId });
  }

  dispose() {
    return this.lifecycle.dispose();
  }
}
