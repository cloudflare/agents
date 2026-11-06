# Pi harness

An example that runs [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable),
pi's durable agent harness, inside a Durable Object. `PiHarness` and the
session store come from `agents/harness/pi`, and the model provider from
`agents/models/pi-ai`. This example adds the app around them.

New to `PiHarness`? Start with the
[Pi harness docs](https://developers.cloudflare.com/agents/harnesses/pi/).

The example composes:

- `PiHarness extends LifecycleCapability`, the harness interface:
  `harness.prompt()`, `harness.submit()`, `harness.sessions`,
  `harness.session(id)`, and `session.watch()` for pi's live view;
- one Lifecycle job as the wake, driven by pi's `onWake`: it keeps the
  object alive while pi has work running, is due when pi's next sleep ends,
  and completes when pi has nothing to do;
- a pi session store on the object's SQLite database;
- app glue that is not part of the harness: `sockets.ts` puts one session
  per socket on `WebSockets`, `mirror.ts` keeps the client's copy of it in
  pi's `ConversationTranscript`, and `view.ts` and `transcript.ts` project
  that into what the UI shows;
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

Reload the page mid-turn: the client gets the session's view, including
the partial answer, and continues from there. A long session shows its
newest messages first; "Load earlier messages" pages back to the newest
context reset. A compaction shows as a small "Earlier messages summarized"
line that opens to the summary.

A submit whose answer the socket never delivered is sent again on
reconnect. The client (`src/outbox.ts`) names every submit with an
`operationId` and keeps it in memory until its `result` or `error` arrives.
The harness deduplicates by operation id, so the submit runs once: one it
already admitted answers `accepted: false`.

## Test

```sh
pnpm test
```

- `sockets.test.ts` connects real WebSockets: a run started over the
  socket, a client joining mid-run, a socket that outlives an eviction or a
  reopened pi, a transcript longer than the watch's window, loading earlier
  pages up to the newest reset, and filling the gap a long disconnection
  leaves.
- `view.test.ts` checks that a client following a run and one joining after
  it project the same view, that a reset hides the context before it, and
  that a compaction shows as a summary notice.
- `outbox.test.ts` checks the client's command outbox, and that a submit
  sent again on reconnect runs once.

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
      new CodemodeBackend({
        loader: this.env.LOADER,
        modules: { "codemode:git": createGitModule({ allowNetwork: true }) }
      })
    ]
  });
  // pi's own registry: the system prompt and the workspace tools.
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      this.registry.install({
        name: "playground",
        sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
        tools: createWorkspaceTools(this.workspace)
      });
      return Harness.open(
        storage,
        { models: this.#models(), registry: this.registry, onWake },
        context
      );
    },
    defaults: { model: this.ai(MODEL_ID), thinkingLevel: "low" }
  });
  // App glue: this app's socket protocol, built on session.watch().
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

The factory builds everything pi's `Harness.open` takes: models, the
registry, and `settings` (this app retries model requests there). The
harness hands it pi's storage over the object's SQLite database, a
background context, and `onWake`, which the factory passes on so pi's
sleeping tasks wake from the object's alarm. The system prompt and tools are a pi extension on the
app's registry; tools are pi-durable `ToolRegistration`s. `replay: "safe"`
lets pi run a call again after an eviction interrupted it; otherwise the
model gets an interrupted result. For `agents/skills` sources,
`this.registry.install(await skills(sources))` in the factory. See the
[Pi harness docs](../../../../docs/agents/harnesses/pi.md).

`defaults` applies to new sessions only; change one session's model with
`session.setModel`. Without a default model, a session's prompts end
unanswered (`no_model`) until one is set.

The harness does not choose a transport. `session.watch()` returns pi's own
conversation view: a window over the transcript and the session's live state,
with pi's operations for each change. This app sends the view, then the
operations, over WebSockets (`src/sockets.ts`, `src/protocol.ts`). The window
is pi's default, the newest 50 to 100 entries. The browser applies the
operations and merges each value into pi's `ConversationTranscript`
(`src/mirror.ts`), which keeps every entry the client has seen, loads
earlier pages and missed entries with `entries` requests that the server
answers from `session.entries()`, and resumes a reconnect after its newest
entry. `projectView` (`src/view.ts`) projects the transcript in the browser
and in the tests.

A watch ends when pi closes, as the harness closes and reopens a pi whose
storage failed. The socket then gets a new watch that continues after the
last entry it sent.

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

`exec` has one backend, `CodemodeBackend`. Each call runs an ES module in a
fresh Dynamic Worker, minted through the `LOADER` binding, with no network.
The module can import `node:fs/promises`, which is the workspace, and
`codemode:git`. computer's own `exec` description is written for a choice of
shell backends, so `src/workspace.ts` replaces it with one for JavaScript
that includes the `codemode:git` TypeScript interface (`clone`, `status`,
`diff`, `log`).

Git needs two things besides the backend: `git: createGitClient()` from
`@cloudflare/computer/git` on the `Workspace`, which needs the
`@platformatic/vfs` peer, and the `codemode:git` module from
`createGitModule({ allowNetwork: true })` (`@cloudflare/computer/modules/git`)
on the backend, which `clone` needs. Git runs in the host, through isomorphic-git on the workspace
files, so cloning works while the module itself has no network.

## Package sources

Pi comes from npm: `@earendil-works/pi-durable`, `pi-ai`, `pi-schema`,
`chord` and `pi-telemetry` at `~1.5.0`. Pi is MIT licensed; see
[`licenses/mit-earendil-pi.txt`](./licenses/mit-earendil-pi.txt).

`@cloudflare/computer` comes from npm at `^0.10.0`, the version Think requires.
It includes the `codemode:git` module that `exec` uses for git (added in 0.5
as `ws:git`, renamed in 0.9).

Note that the repository sets `minimumReleaseAge: 1440` in
`pnpm-workspace.yaml`, so a pi release less than 24 hours old will not
install until it ages out or `@earendil-works/*` is listed in
`minimumReleaseAgeExclude`.
