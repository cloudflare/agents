# OpenCode harness

An experimental example that runs [OpenCode](https://github.com/anomalyco/opencode)'s
embedded SDK (`@opencode/sdk/workerd`) inside a Durable Object.
`OpenCodeHarness` comes from `agents/harness/opencode`, and the model
provider from `agents/models/opencode`. Both entry points are experimental.
This example adds the app around them, and is laid out like the
[Pi harness example](../pi): the same UI, socket protocol, view, and
workspace tools.

The one thing it adds is the OpenCode CLI: every session in the UI can also
be opened from a terminal (see [OpenCode CLI](#opencode-cli)).

The example composes:

- `OpenCodeHarness extends LifecycleCapability`, the harness interface:
  `harness.prompt()`, `harness.submit()`, `harness.sessions`,
  `harness.session(id)`, and `session.events()` for the session's live
  events; `harness.fetch()` serves OpenCode's own HTTP API;
- one Lifecycle job per session as the lease: it brings the object back
  after an unplanned eviction, so OpenCode can resume the turn, and a
  healthy turn cancels it when it ends;
- OpenCode's own tables on the object's SQLite database, and a `Streams`
  capability for each operation's record;
- app glue that is not part of the harness: `sockets.ts` puts one session
  per socket on `WebSockets`, and `view.ts` and `transcript.ts` fold the
  harness's messages and events into what the UI shows;
- a `Workspace` from `@cloudflare/computer` on the same SQLite database,
  and its tools for the model, in place of OpenCode's local filesystem and
  shell tools (see [Workspace](#workspace));
- `createAI` from `agents/models/opencode`: OpenCode's own Workers AI
  provider and catalog, over the `AI` binding.

OpenCode owns the transcript, the inbox of queued and steering prompts, the
execution claim, retries, and recovery, all in its own tables. The SDK
supplies the lease, the storage, and the socket.

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

Each session is its own Durable Object with its own workspace and its own
OpenCode database.

## What to try

- `Write a haiku about Durable Objects to /workspace/haiku.txt, then read it back.`
- `Use exec to run JavaScript that lists /workspace and returns the size of each file.`
- `Clone https://github.com/octocat/Hello-World into /workspace/hello, then show its git log.`
- While a turn runs, type and press Enter to queue a follow-up, or Steer to
  join the running turn.

Reload the page mid-turn: the client gets a snapshot of the current state
and continues from there.

## OpenCode CLI

The CLI speaks OpenCode's HTTP API, and the harness serves it with
`harness.fetch()`. Point the CLI at a session's object, and it reaches the
same OpenCode the UI is talking to. The UI's Tools panel shows the command
for the open session:

```sh
npx @opencode/cli@2 --server http://localhost:5173/agents/open-code-agent/<name> --session <ses_id>
```

`<name>` is the object (the UI keeps it in `localStorage`), and `<ses_id>` is
OpenCode's id for the session, which the UI receives in its `hello`. Without
`--session`, the CLI opens a session of its own in the same object. A turn
started in either place shows up in both.

`routeAgentRequest` sends `/agents/open-code-agent/<name>/...` to the
object. Its `onRequest` drops that prefix and passes the request to
`harness.fetch()` (`src/cli.ts`). Use version 2 of the CLI
(`@opencode/cli`); the 1.x `opencode-ai` CLI speaks an older API.

## Test

```sh
pnpm test
```

- `sockets.test.ts` connects real WebSockets: a turn with a tool call
  started over the socket, a client joining mid-turn, and a socket that
  outlives an eviction. It also requests OpenCode's API under the object's
  URL, as the CLI does.
- `view.test.ts` checks that a client following a turn and one joining after
  it fold the events into the same view.

Both run the example's composition with a scripted model behind
`createAI`'s binding.

The harness's own tests live with it in `packages/agents`
(`pnpm run test:harness:opencode` there): admission, sessions, the lease,
full turns through `agents/models/opencode`, a failed turn, the event
stream, and OpenCode's HTTP API.

## Core pattern

```ts
export class OpenCodeAgent extends DurableObject<Env> {
  readonly ai = createAI({ binding: this.env.AI });
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
  readonly tools = createWorkspaceTools(this.workspace);
  readonly streams = new Streams();
  readonly harness = new OpenCodeHarness({
    streams: this.streams,
    providers: [this.ai.provider],
    plugins: [this.tools.plugin],
    config: { agents: { build: { system: PREAMBLE } } },
    defaults: { model: this.ai(MODEL_ID) }
  });
  readonly sockets = new OpenCodeSessionSockets(
    this.harness,
    this.tools.tools,
    (tag) => this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.streams)
    .use(this.webSockets);

  async onStart() {
    await this.sockets.reattach();
  }

  async onRequest(request: Request) {
    return this.harness.fetch(openCodeRequest(request));
  }

  async answer() {
    const { text } = await this.harness.prompt("What is 47 × 19?");
    const side = await this.harness.sessions.create();
    await side.submit("Summarise the repo", { whenBusy: "steer" });
    return text;
  }
}
```

The options are OpenCode's own pieces. `providers` are model providers:
`ai.provider` is the config entry for OpenCode's Workers AI provider and the
plugin that serves it. `plugins` are OpenCode plugins: tools, hooks, agents.
`config` is OpenCode's config; this app sets the build agent's system
prompt. OpenCode's tables share the object's database with the Workspace's
and the SDK's (see `NOTES.md`).

`defaults` applies to sessions the harness creates; change one session's
model with `session.setModel`.

The harness does not choose a transport. `session.events()` returns the
session's events: a `snapshot`, then each event, with a fresh snapshot after
each operation starts and ends. This app sends them over WebSockets
(`src/sockets.ts`, `src/protocol.ts`) and folds them with `reduceView`
(`src/view.ts`) in the browser and in the tests.

`harness.messages()` and `prompt()`'s `messages` are OpenCode's messages,
projected to text, reasoning, and tool parts. The display model the UI
renders is this app's projection of them, in `src/transcript.ts`, which is
the same model the Pi example uses.

## Workspace

The model works in a `Workspace` from
[`@cloudflare/computer`](https://github.com/cloudflare/computer), stored on
the object's SQLite database beside OpenCode's tables. Its tools come from
`createPiTools` in `@cloudflare/computer/tools/pi-ai`: `read`, `ls`, `find`,
`grep`, `write`, `edit`, `delete`, and `exec`. Despite its name it needs
nothing from pi: it returns plain JSON Schema declarations and one
`execute`.

OpenCode takes JSON Schema as a tool's input, so `createWorkspaceTools` in
`src/workspace.ts` turns each declaration into an OpenCode tool that calls
`execute`, inside one plugin. The workerd profile has no local filesystem or
shell, so the plugin also removes OpenCode's built-in tools that expect one,
some of which share these names.

`exec` has one backend, `WorkerJavaScriptBackend`, exactly as in the Pi
example: each call runs an ES module in a fresh Dynamic Worker, minted
through the `LOADER` binding, with no network, and can import
`node:fs/promises` and `ws:git`.

## Package sources

OpenCode comes from npm: `@opencode/sdk` and `@opencode/plugin` at
`^2.0.15`. `@cloudflare/computer` comes from npm at `^0.4.0`.

Note that the repository sets `minimumReleaseAge: 1440` in
`pnpm-workspace.yaml`; `@opencode/*` is listed in `minimumReleaseAgeExclude`.
