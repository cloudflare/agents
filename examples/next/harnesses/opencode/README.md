# OpenCode harness

An experimental example that runs [OpenCode v2](https://opencode.ai/v2/docs/build/sdk/cloudflare/)
(`@opencode/sdk/workerd`) inside a Durable Object. `OpenCodeHarness` comes
from `agents/harness/opencode`, and the Workers AI provider from
`agents/models/opencode`. Both entry points are experimental and will change.
This example is the only documentation for them for now.

## What it shows

- **`OpenCodeHarness`**, a Lifecycle capability with the same interface as
  `PiHarness`: `harness.prompt()`, `harness.submit()`, `harness.sessions`,
  `harness.session(id)`. Each session also has `history()`, `events()` for
  OpenCode's live events, and `log()` for its durable ones. A factory opens
  OpenCode:

  ```ts
  readonly harness = new OpenCodeHarness({
    opencode: ({ storage }) =>
      OpenCodeWorkerd.create({ storage, plugins: [this.ai.plugin] }),
    defaults: { model: this.ai("@cf/moonshotai/kimi-k2.7-code") }
  });
  ```

- **Storage.** The `storage` the factory gets keeps OpenCode's tables under
  an `opencode_` prefix in the object's SQLite database, so they don't
  collide with the SDK's or yours. OpenCode has no option for this yet
  ([anomalyco/opencode#53577](https://github.com/anomalyco/opencode/issues/53577)),
  so the harness rewrites OpenCode's SQL.
- **The wake.** Each session gets one Lifecycle job. The job waits while the
  session runs and completes once the session is idle. If the object is
  evicted or crashes mid-turn, the job's alarm restarts it, OpenCode resumes
  the turn, and the job waits again. This works with no client connected.
- **Hibernation.** An open OpenCode runs background timers that keep the
  object in memory. The harness closes OpenCode 30 seconds after its last
  use, once nothing is running, and reopens it on the next call.
- **`createAI` from `agents/models/opencode`.** Workers AI as an OpenCode
  plugin, over the `AI` binding: no account id or API token.
- **App glue that isn't part of the harness.**
  - `sockets.ts` puts sessions on `WebSockets`. Each socket gets a snapshot
    of the transcript. While a session runs, one watch on `session.events()`
    fans OpenCode's events out to every socket on it, and the watch stops
    when the session is idle.
  - `plugin.ts` removes OpenCode's file and shell tools, which have nothing
    to run on in Workers, and adds notes kept in the object's storage.

## Run locally

```sh
pnpm install
pnpm run start
```

The example uses the remote Workers AI binding, which may incur Workers AI
usage. It needs no API key. If your Wrangler login can see more than one
account, set `CLOUDFLARE_ACCOUNT_ID` when starting.

Each browser gets its own Durable Object, named by a random id kept in
`localStorage`. That id is the only thing standing between one browser's
chats and another's: anyone who has it can read and use them. A real app
routes to an object the user is authorized for, and puts quotas on prompts:
this example only caps a prompt at 100,000 characters. OpenCode adds
about 3.7 MB (gzip) to the Worker, so deploying needs the Workers Paid plan.

## What to try

- `Save a note titled 'groceries' with milk, eggs and bread, then list my notes.`
- `Fetch https://example.com and tell me the page's title.`
- While a turn runs, press Enter to queue a follow-up, Steer to join the
  running turn, or Stop to interrupt it.
- Reload mid-turn: you get the transcript so far, and the rest streams in.
- Open the same page in two tabs: both follow the session live.
- Create sessions from the sidebar. They run independently and in parallel.

## What OpenCode can't do here

OpenCode's Workers profile has no filesystem, shell or terminal, so those
tools are removed. Add your own through OpenCode plugins, as `plugin.ts`
does. OpenCode wraps plugin tools in its `execute` code-mode tool, so a
tool call shows up as `execute`.

On boot, OpenCode's local provider plugins (Ollama, LM Studio, vLLM) try to
reach `127.0.0.1`. Those requests fail harmlessly.

If a turn is cut off by a restart, OpenCode keeps only the text it had
already committed. It resumes with a note to the model to continue, and the
model sometimes starts over or wraps up early.

## Vite

`vite.config.ts` stubs one file inside `effect`, which OpenCode is built on:
the Scalar API reference UI, which Vite's import analysis can't parse and
OpenCode never serves here. Wrangler builds the Worker without the stub.
