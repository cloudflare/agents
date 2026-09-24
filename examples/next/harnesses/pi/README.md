# Pi harness

This example runs Pi's durable `AgentHarness` inside a Durable Object through `agents/pi` and `agents/driver`.

Pi owns the transcript, model loop, tool intent, tool results, retries, cancellation, and recovery. The shared driver owns durable intake, one alarm-backed job per lane, first-in-first-out admission, and wake-up after eviction. Streams retain client output and WebSockets provide the browser protocol.

## Run locally

```sh
pnpm install
pnpm run start
```

The example uses the remote Workers AI binding and may incur Workers AI usage. It needs no API key. Set `CLOUDFLARE_ACCOUNT_ID` when the Wrangler login can access more than one account.

## Test

```sh
pnpm test
```

The test uses Pi's faux provider. It submits a tool turn, evicts the Durable Object, resumes through the shared driver, and verifies multiple lanes can progress independently.

## Composition

```ts
import { PiHarness, createModels } from "agents/pi";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { WebSockets } from "agents/websockets";

readonly streams = new Streams();
readonly harness = new PiHarness({
  models: createModels({ providers: [workersAI(this.env.AI)] }),
  model: {
    provider: "cloudflare-workers-ai",
    modelId: MODEL_ID
  },
  streams: this.streams,
  tools: () => tools
});
readonly webSockets = new WebSockets(this.harness.webSockets());
readonly lifecycle = Lifecycle.install(this)
  .use(this.streams)
  .use(this.harness.driver)
  .use(this.webSockets)
  .use(this.harness);
```

Each Pi lane is a driver scope. Submissions remain ordered within one lane, while model and remote-tool waits on different lanes can overlap. Pi's native durable state remains the execution authority.
