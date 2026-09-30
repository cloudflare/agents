# Pi harness

An experimental example that runs [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable),
pi's durable agent harness, inside a Durable Object. Nothing here is exported
from the `agents` package. `PiHarness`, the driver, the session store, and
the Workers AI provider all live in this example's `src/` and pin an
unreleased pi build.

The example composes:

- `PiHarness extends LifecycleCapability`, the harness interface:
  `harness.prompt()`, `harness.submit()`, `harness.sessions`,
  `harness.session(id)`, `harness.webSockets()`;
- a `Driver` (copied into `src/driver` from cloudflare/agents#2396) that
  wakes the object and sees each submission through to pi's answer;
- a pi session store on the object's SQLite database (`session-store.ts`);
- `WebSockets` to serve pi's own agent events to the browser;
- `agents/skills` for a bundled `trip-planning` skill;
- pi-ai's Workers AI provider, transported over the `AI` binding.

pi owns the transcript, the inbox of steers and follow-ups, generation and
tool tasks, retries, recovery, and the live view, all in its own tables. The
SDK supplies the wake, the storage facade, and the socket.

`NOTES.md` has the design decisions and everything that was hard or is still
missing.

## Run locally

```sh
pnpm install
pnpm run start
```

The example uses the remote Workers AI binding and may incur Workers AI
usage. It needs no API key. If your Wrangler login has access to more than
one account, set `CLOUDFLARE_ACCOUNT_ID` when starting.

## What to try

- `Roll four 12-sided dice and total them.`
- `Use the calculator to multiply 47 by 19.`
- `Remember that my favourite launch snack is stroopwafels.`, then in a
  later message `What did I tell you my favourite launch snack was?`
- `I want to plan a trip.` activates the bundled skill.
- While a turn runs, type and press Enter to queue a follow-up, or Steer to
  join the running turn.

Reload the page mid-turn: the client gets a snapshot of the current state,
including the partial answer, and continues from there.

## Test

```sh
pnpm test
```

- `session-store.test.ts` runs pi's own storage conformance suite against
  the session store on a real Durable Object.
- `harness.test.ts` drives a real Durable Object with pi-ai's faux provider:
  tool turns, follow-ups queued behind a run, abort, sessions, and a crash
  mid-tool-call that the driver's alarm recovers (a replay-safe tool reruns,
  an unsafe one is reported to the model as interrupted).
- `transport.test.ts` connects real WebSockets: a run started over the
  socket, a client joining mid-run, and a socket that outlives an eviction.

## Core pattern

```ts
export class PiAgent extends DurableObject<Env> {
  readonly driver = new Driver();
  readonly harness = new PiHarness({
    driver: this.driver,
    models: createModels({ providers: [workersAI(this.env.AI)] }),
    model: { provider: "cloudflare-workers-ai", modelId: MODEL_ID },
    tools: createTools(this.ctx.storage),
    skills: [skills]
  });
  readonly webSockets = new WebSockets(this.harness.webSockets());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.driver)
    .use(this.webSockets)
    .use(this.harness);
}

// Anywhere in the object:
const { text } = await this.harness.prompt("What is 47 × 19?");
const side = await this.harness.sessions.create();
await side.submit("Summarise the repo", { whenBusy: "steer" });
```

Tools are pi-durable `ToolRegistration`s. `replay: "safe"` lets pi run a
call again after an eviction interrupted it; otherwise the model gets an
interrupted result. `configure(registry)` adds pi hooks, prompt sections, or
tasks.

The wire is pi's own `AgentEvent`s: a `snapshot`, then one batch per commit,
folded by `reduceView` in `src/harness/view.ts` on both sides.

## Pi source

The build pins `earendil-works/pi` commit `2bbfcca4` as vendored archives
under `vendor/pi-dev`. `vendor/pi-dev/pack.mjs` rebuilds them from a pi
checkout. Pi is MIT licensed; see
[`licenses/mit-earendil-pi.txt`](./licenses/mit-earendil-pi.txt).
