# Pi harness playground

A playable pi `AgentHarness` composed from the SDK's durable primitives on
one Lifecycle Durable Object: `Tasks` drives each conversation lane to
settlement and replays it after eviction, `Streams` durably records every
operation's live output, and the `WebSockets` capability serves it to the
browser — so the UI streams tokens as pi generates them, not just the
finished turn, and a page refresh mid-turn resumes exactly where the last
chunk left off.

## Run locally

```bash
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
- `List everything you remember.`
- `Use a tool to tell me the current UTC time.`
- `I want to plan a trip.` — activates the bundled `trip-planning` skill via
  `agents/skills`.

The model can call `calculate`, `roll_dice`, `remember`, `recall`,
`list_memories`, and `current_time`, plus `activate_skill` and
`read_skill_resource` for the bundled skill. Tool calls and results render
live as they happen. Reload the page mid-turn — the transcript and the
in-flight response resume from the durable stream. Use **New session** to
start with a new Durable Object.

## Core pattern

```ts
export class PiAgent extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();

  readonly harness = new PiHarness({
    models: createModels({ providers: [workersAI(this.env.AI)] }),
    model: {
      provider: "cloudflare-workers-ai",
      modelId: "@cf/moonshotai/kimi-k2.7-code"
    },
    tasks: this.tasks,
    streams: this.streams,
    tools: () => tools,
    toolContext: { storage: this.ctx.storage }
  });

  readonly webSockets = new WebSockets(this.harness.webSockets());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.webSockets)
    .use(this.harness);
}
```

Import `PiHarness` from `agents/harness` and `createModels`/`workersAI` from
`agents/providers/pi`. Each lane's work runs as one `Tasks` run whose
replayable step drives pi to settlement — the run replays after eviction
using pi's own durable session as recovery evidence. Every operation's live
events (message deltas, tool progress, turn boundaries) land in one `Streams`
stream, and `harness.webSockets()` returns the options for a `WebSockets`
capability that serves a small JSON protocol: connect for a lane snapshot,
`subscribe` to replay-then-tail an operation's stream from a client cursor,
`submit`/`abort`/`steer` to drive it. See `src/use-pi-session.ts` for the
client side of that protocol.

`createModels()` starts with an empty provider registry — register
`workersAI()` for the zero-config Workers AI binding. pi-ai's complete
built-in catalog (Anthropic, OpenAI, Google, and the rest) is available from
`agents/providers/pi/catalog`, kept off the default import path since some
providers pull in vendor SDKs a Workers build can't always resolve.
