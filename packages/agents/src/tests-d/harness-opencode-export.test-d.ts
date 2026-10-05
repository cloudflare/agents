import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "../lifecycle";
import {
  OpenCodeHarness,
  ROOT_SESSION,
  type OpenCodeEvent,
  type OpenCodeEventStream,
  type OpenCodeHarnessOptions,
  type OpenCodeMessage,
  type OpenCodeOperationResult,
  type OpenCodePendingOperation,
  type OpenCodePromptResponse,
  type OpenCodeReceipt,
  type OpenCodeSessionInfo,
  type OpenCodeWhenBusy
} from "../harness/opencode";
import { createAI } from "../models/opencode";
import { Streams } from "../streams";

declare const binding: Ai;

class OpenCodeObject extends DurableObject {
  readonly ai = createAI({ binding });
  readonly streams = new Streams();
  readonly harness = new OpenCodeHarness({
    streams: this.streams,
    providers: [this.ai.provider],
    defaults: { model: this.ai("@cf/moonshotai/kimi-k2.7-code") }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.streams);
}

declare const object: OpenCodeObject;
const harness = object.harness;

harness.prompt("hi") satisfies Promise<OpenCodePromptResponse>;
harness.submit("hi", {
  operationId: "op",
  whenBusy: "followUp"
}) satisfies Promise<OpenCodeReceipt>;
harness.wait("op") satisfies Promise<OpenCodeOperationResult>;
harness.abort() satisfies Promise<boolean>;
harness.messages() satisfies Promise<OpenCodeMessage[]>;
harness.pending() satisfies Promise<OpenCodePendingOperation[]>;
harness.sessions.list() satisfies Promise<OpenCodeSessionInfo[]>;

const session = harness.session(ROOT_SESSION);
session.steer("more") satisfies Promise<OpenCodeReceipt>;
session.events() satisfies Promise<OpenCodeEventStream>;
session.busy() satisfies Promise<boolean>;

harness.fetch(
  new Request("http://opencode/api/session")
) satisfies Promise<Response>;

declare const result: OpenCodeOperationResult;
result.status satisfies "done" | "unanswered";

declare const whenBusy: OpenCodeWhenBusy;
whenBusy satisfies "followUp" | "steer";

declare const stream: OpenCodeEventStream;
stream.snapshot.type satisfies "snapshot";
stream.start((events: readonly OpenCodeEvent[]) => {
  events satisfies readonly OpenCodeEvent[];
});

({
  streams: object.streams,
  lease: { ttlMs: 60_000, stallLimit: 5 }
}) satisfies OpenCodeHarnessOptions;
