# Pi harness

An experimental example that runs pi's durable `AgentHarness` inside a plain
Durable Object, behind the shared `Harness` capability every example under
`examples/next/harnesses` composes. Nothing here is exported from the `agents`
package yet; `PiRuntime`, the shared harness and the Workers AI provider live
in these examples and pin an unreleased pi build.

The example composes:

- `Harness` from `@cloudflare/agents-next-harness` for admission, the durable
  inbox, operation and request rows, the event logs and the browser link;
- `PiRuntime` for the agent loop: it attaches pi to this object's SQLite
  state, admits each inbox row into pi under the operation id the base minted,
  drives the lane to settlement, and projects pi's events;
- `Tasks` to run one driver per session and replay it after eviction;
- `Streams` to durably record every operation's events;
- `WebSockets` to serve the harness link to the browser;
- `agents/skills` for a bundled `trip-planning` skill;
- pi-ai's Workers AI provider, transported over the `AI` binding.

Pi owns the transcript, tool intents and results, retries and recovery. The
shared capability owns everything a client sees, so this example speaks the
same developer API as every other harness:

```ts
const session = agent.harness.session(); // one pi lane
const { operationId } = await session.prompt("Roll 4d12");
const result = await session.wait(operationId);
```

One pi lane is one harness session: `harness.session("main")` is pi's `main`
lane, and the runtime advertises `sessions`, `steer`, `compact` and `usage`.
A prompt sent with `{ delivery: "steer" }` is handed to `lane.steer()` while
its turn runs and settles as soon as pi has taken it; `compact()` becomes a pi
compaction operation; `submit()` carries pi's own operations: `skill`,
`prompt_template` and `navigation`.

## Run locally

```sh
pnpm install
pnpm run start
```

The example uses the remote Workers AI binding and may incur Workers AI usage.
It needs no API key. If your Wrangler login has access to more than one
account, set `CLOUDFLARE_ACCOUNT_ID` when starting.

## What to try

- `Roll four 12-sided dice and total them.`
- `Use the calculator to multiply 47 by 19.`
- `Remember that my favourite launch snack is stroopwafels.`
- `What did I tell you my favourite launch snack was?`
- `I want to plan a trip.` activates the bundled skill.
- Type again while a turn is running: the message steers it.

Tool calls and results render live as they happen. Reload the page mid-turn
and the transcript and in-flight reply resume from the durable log. Use the
new-session button to start with a fresh Durable Object.

## Test

```sh
pnpm test
```

The suite runs a real Durable Object with pi-ai's faux provider: it drives a
tool call to settlement, evicts the object and checks the transcript and a
second turn survive, replays the durable log from a cursor, steers a running
operation, and interrupts one.

## Core pattern

```ts
export class PiAgent extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();

  readonly harness = new Harness<PiProtocol>({
    tasks: this.tasks,
    streams: this.streams,
    runtime: new PiRuntime({
      models: createModels({ providers: [workersAI(this.env.AI)] }),
      model: { provider: "cloudflare-workers-ai", modelId: MODEL_ID },
      tools: () => tools
    })
  });

  readonly webSockets = new WebSockets(this.harness.webSockets());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.webSockets)
    .use(this.harness);
}
```

Harnesses differ by runtime, never by subclass: swapping `PiRuntime` for
another `HarnessRuntime` changes the engine and nothing else. The browser side
is the one shared hook:

```ts
const { messages, live, status, prompt, interrupt } =
  useHarnessSession<PiProtocol>({ agent: "pi-agent", name: session });
```

Demo features the harness link deliberately does not carry (here, the tool
catalog the sidebar lists) are plain HTTP routes on the Durable Object:
`onRequest()` answers `/agents/pi-agent/<name>/tools`.

## Pi source

The build pins `earendil-works/pi` commit `c4b0e35a` as vendored archives under
`vendor/pi-dev`. Pi is MIT licensed; see
[`licenses/mit-earendil-pi.txt`](./licenses/mit-earendil-pi.txt). The harness
design is in
[`design/rfc-harness-capability.md`](../../../../design/rfc-harness-capability.md),
and the example it replaces in
[`design/rfc-pi-harness-example.md`](../../../../design/rfc-pi-harness-example.md).
