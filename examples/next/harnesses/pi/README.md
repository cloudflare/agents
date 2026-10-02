# Pi harness

An experimental example that runs [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable),
pi's durable agent harness, inside a Durable Object. `PiHarness` and the
session store come from `agents/harness/pi`, and the model provider from
`agents/models/pi-ai`. Both entry points are experimental. This example adds
the app around them.

The example composes:

- `PiHarness extends LifecycleCapability`, the harness interface:
  `harness.prompt()`, `harness.submit()`, `harness.sessions`,
  `harness.session(id)`, and `session.events()` for pi's live events;
- one Lifecycle job per session as the wake: it keeps the object alive while
  pi has live tasks in the session, and completes when there are none;
- a pi session store on the object's SQLite database;
- app glue that is not part of the harness: `sockets.ts` puts one session
  per socket on `WebSockets`, and `view.ts` and `transcript.ts` fold pi's
  entries and events into what the UI shows;
- a `Workspace` from `@cloudflare/computer` on the same SQLite database,
  and its tools for the model (see [Workspace](#workspace));
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

Each session is its own Durable Object with its own workspace. pi fixes a
session's active tools when it creates the session, so a session created
before a tool was added never sees it; start a new session instead.

## What to try

- `Write a haiku about Durable Objects to /workspace/haiku.txt, then read it back.`
- `Use exec to run JavaScript that lists /workspace and returns the size of each file.`
- `Clone https://github.com/octocat/Hello-World into /workspace/hello, then show its git log.`
- While a turn runs, type and press Enter to queue a follow-up, or Steer to
  join the running turn.

Reload the page mid-turn: the client gets a snapshot of the current state,
including the partial answer, and continues from there.

## Test

```sh
pnpm test
```

- `sockets.test.ts` connects real WebSockets: a run started over the
  socket, a client joining mid-run, and a socket that outlives an eviction.
- `view.test.ts` checks that a client following a run and one joining after
  it fold pi's events into the same view.

The harness's own tests live with it in `packages/agents`
(`pnpm run test:harness:pi` there): pi's storage conformance suite on a
real Durable Object, tool turns, follow-ups, abort, sessions, a harness
without defaults, and a crash mid-tool-call that the wake job's alarm
recovers.

## Core pattern

```ts
export class PiAgent extends DurableObject<Env> {
  // Workers AI and AI Gateway over the AI binding, as a pi-ai provider.
  readonly ai = createAI({ binding: this.env.AI });
  // A durable filesystem with git; `exec` runs JavaScript in a Dynamic Worker.
  readonly workspace = new Workspace({
    storage: this.ctx.storage,
    git: createGitClient(),
    backends: [
      new WorkerJavaScriptBackend({
        id: JAVASCRIPT_BACKEND,
        loader: this.env.LOADER,
        allowGitNetwork: true
      })
    ]
  });
  // pi's own registry: system prompt and the workspace tools.
  readonly registry = createAppRegistry(this.workspace);
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
`await addSkills(registry, sources)` from `agents/harness/pi` in the
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

`harness.messages()` and `prompt()`'s `messages` are pi's own transcript
entries (`EntryRecord`). The display model the UI renders is this app's
projection of them, in `src/transcript.ts`.

## Workspace

The model works in a `Workspace` from
[`@cloudflare/computer`](https://github.com/cloudflare/computer), stored on
the object's SQLite database beside pi's tables. Its tools come from
`createPiTools` in `@cloudflare/computer/tools/pi-ai`: `read`, `ls`, `find`,
`grep`, `write`, `edit`, `delete`, and `exec`. See computer's
[tool interface docs](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md).

`createPiTools` returns pi-ai declarations and one `execute`, for an agent
loop the caller writes. pi-durable runs the loop itself, so
`createWorkspaceTools` in `src/workspace.ts` turns each declaration into a
`ToolRegistration` that calls `execute`. It marks `read`, `ls`, `find`,
`grep`, `write` and `delete` replay-safe. `edit` and `exec` are not: after
an eviction the model gets an interrupted result rather than a second run.

`exec` has one backend, `WorkerJavaScriptBackend`. Each call runs an ES
module in a fresh Dynamic Worker, minted through the `LOADER` binding, with
no network. The module can import `node:fs/promises`, which is the
workspace, and `ws:git`. computer's own `exec` description is written for a
choice of shell backends, so `src/workspace.ts` replaces it with one for
JavaScript that includes the `ws:git` TypeScript interface (`clone`,
`status`, `diff`, `log`).

Git needs two things besides the backend: `git: createGitClient()` from
`@cloudflare/computer/git` on the `Workspace`, which needs the
`@platformatic/vfs` peer, and `allowGitNetwork: true` on the backend for
`clone`. Git runs in the host, through isomorphic-git on the workspace
files, so cloning works while the module itself has no network.

## Package sources

Pi comes from npm: `@earendil-works/pi-durable`, `pi-ai`, `chord` and
`pi-telemetry` at `^0.99.2`. Pi is MIT licensed; see
[`licenses/mit-earendil-pi.txt`](./licenses/mit-earendil-pi.txt).

`@cloudflare/computer` comes from npm at `^0.4.0`, the first release with
`@cloudflare/computer/tools/pi-ai`.

Note that the repository sets `minimumReleaseAge: 1440` in
`pnpm-workspace.yaml`, so a pi release less than 24 hours old will not
install until it ages out or `@earendil-works/*` is listed in
`minimumReleaseAgeExclude`.
