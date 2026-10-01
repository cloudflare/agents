# Pi harness

An experimental example that runs [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable),
pi's durable agent harness, inside a Durable Object. `PiHarness` and the
session store live in this example's `src/`, on pi's published npm packages
(see [Pi source](#pi-source)). The model provider is `agents/models/pi-ai`.

The example composes:

- `PiHarness extends LifecycleCapability`, the harness interface:
  `harness.prompt()`, `harness.submit()`, `harness.sessions`,
  `harness.session(id)`, and `session.events()` for pi's live events;
- one Lifecycle job per session as the wake: it keeps the object alive while
  pi has live tasks in the session, and completes when there are none;
- a pi session store on the object's SQLite database (`session-store.ts`);
- app glue that is not part of the harness: `sockets.ts` puts one session
  per socket on `WebSockets`, and `view.ts` folds pi's events into what the
  UI shows;
- two tools: `current_time`, and `sleep`, a replay-safe wait whose
  deadline survives an eviction;
- `createAI` from `agents/models/pi-ai`: Workers AI, and other vendors through
  AI Gateway, all over the `AI` binding, registered on pi's `Models`.

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

- `What time is it?`
- `Tell me the time, sleep for 10 seconds, then tell me the time again.`
- `Sleep for 2 minutes, then tell me how long you actually slept.` The
  object stays alive through the wake job's alarm, not through
  `sleep`'s timer.
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
  mid-tool-call that the wake job's alarm recovers (a replay-safe tool reruns,
  an unsafe one is reported to the model as interrupted).
- `sockets.test.ts` connects real WebSockets: a run started over the
  socket, a client joining mid-run, and a socket that outlives an eviction.

## Core pattern

```ts
export class PiAgent extends DurableObject<Env> {
  // Workers AI and AI Gateway over the AI binding, as a pi-ai provider.
  readonly ai = createAI({ binding: this.env.AI });
  // pi's own registry: system prompt, tools (sleep, current_time), hooks.
  readonly registry = createAppRegistry();
  readonly harness = new PiHarness({
    harness: ({ storage, context }) =>
      Harness.open(
        storage,
        {
          models: this.#models(), // createModels() with this.ai.provider set
          registry: this.registry
        },
        context
      ),
    defaults: {
      model: { provider: "cloudflare", modelId: MODEL_ID }
    }
  });
  // App glue: this app's socket protocol, built on session.events().
  readonly sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  async onStart() {
    await this.sockets.reattach(); // watches are in memory
  }
}

// Anywhere in the object:
const { text } = await this.harness.prompt("What is 47 × 19?");
const side = await this.harness.sessions.create();
await side.submit("Summarise the repo", { whenBusy: "steer" });
```

The system prompt, tools, hooks and tasks are composed on pi's own
`Registry` (`createRegistry()` from `@earendil-works/pi-durable`); the
harness never sees it. Tools are pi-durable `ToolRegistration`s.
`replay: "safe"` lets pi run a call again after an eviction interrupted it;
otherwise the model gets an interrupted result. For `agents/skills` sources,
`await addSkills(registry, sources)` (`src/harness/skills.ts`) in the
factory, before `Harness.open`.

### Options

Only `harness` is required. It opens pi's `Harness` over the store the
object prepared, so the registry, `models`, `env`, `onReport` and any other
`Harness.open` option belong to it.

`defaults` applies to new sessions only — change one session's model with
`session.setModel`. Without a default model, a session's prompts end
unanswered (`no_model`) until one is set. `timing` overrides how long the
wake waits and when a long wait is handed to the alarm; the defaults suit a
deployment and the tests shorten them.

The harness does not choose a transport. `session.events()` returns pi's own
`AgentEvent` stream: a `snapshot`, then one batch per commit. This app sends
it over WebSockets (`src/sockets.ts`, `src/protocol.ts`) and folds it with
`reduceView` (`src/view.ts`) in the browser and in the tests.

## Pi source

Pi comes from npm: `@earendil-works/pi-durable`, `pi-ai`, `chord` and
`pi-telemetry` at `^0.99.2`. Pi is MIT licensed; see
[`licenses/mit-earendil-pi.txt`](./licenses/mit-earendil-pi.txt).

Note that the repository sets `minimumReleaseAge: 1440` in
`pnpm-workspace.yaml`, so a pi release less than 24 hours old will not
install until it ages out or `@earendil-works/*` is listed in
`minimumReleaseAgeExclude`.
