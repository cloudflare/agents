# Pi harness

An experimental example that runs pi's durable `AgentHarness` inside a plain
Durable Object, composed from the SDK's Lifecycle capabilities. Nothing here is
exported from the `agents` package yet; `PiHarness` and the Workers AI provider
live in this example's `src/` and pin an unreleased pi build.

The example composes:

- `PiHarness extends LifecycleCapability` for the durable agent loop;
- `Tasks` to drive each conversation lane to settlement and replay after
  eviction;
- `Streams` to durably record every operation's live output;
- `WebSockets` to serve that output to the browser;
- `agents/skills` for a bundled `trip-planning` skill;
- pi-ai's Workers AI provider, transported over the `AI` binding.

Pi owns the transcript, tool intents and results, retries, and recovery. The
SDK supplies durable wakes, the output log, and the client transport.

## Run locally

```sh
pnpm install
pnpm run start
```

The example uses the remote Workers AI binding and may incur Workers AI usage.
It needs no API key.

## What to try

- `Roll four 12-sided dice and total them.`
- `Use the calculator to multiply 47 by 19.`
- `Remember that my favourite launch snack is stroopwafels.`
- `What did I tell you my favourite launch snack was?`
- `I want to plan a trip.` activates the bundled skill.

Tool calls and results render live as they happen. Reload the page mid-turn
and the transcript and in-flight reply resume from the durable stream. Use the
new-session button to start with a fresh Durable Object.

## Test

```sh
pnpm test
```

The test runs a real Durable Object with pi-ai's faux provider, drives a tool
call to settlement, evicts the object, and checks the transcript and a second
turn survive.

## Core pattern

```ts
export class PiAgent extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();

  readonly harness = new PiHarness({
    models: createModels({ providers: [workersAI(this.env.AI)] }),
    model: { provider: "cloudflare-workers-ai", modelId: MODEL_ID },
    tasks: this.tasks,
    streams: this.streams,
    tools: () => tools
  });

  readonly webSockets = new WebSockets(this.harness.webSockets());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.webSockets)
    .use(this.harness);
}
```

Each lane's work runs as one `Tasks` run whose replayable step drives pi to
settlement. Every operation's events land in one `Streams` stream, and
`harness.webSockets()` returns the options for a `WebSockets` capability that
serves a small JSON protocol: a lane snapshot on connect, `subscribe` to
replay-then-tail an operation's stream from a client cursor, and `submit`,
`abort`, and `steer` to drive it. `src/use-pi-session.ts` is the client side.

## Pi source

The build pins `earendil-works/pi` commit `c4b0e35a` as vendored archives under
`vendor/pi-dev`. Pi is MIT licensed; see
[`licenses/mit-earendil-pi.txt`](./licenses/mit-earendil-pi.txt). The design
and the work left before this can become a package export are in
[`design/rfc-pi-harness-example.md`](../../../design/rfc-pi-harness-example.md).
