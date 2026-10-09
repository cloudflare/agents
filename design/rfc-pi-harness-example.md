Status: proposed

# pi-durable as a Lifecycle capability

## The problem

pi's durable harness, `@earendil-works/pi-durable`, has the whole execution
model we need:

- transcript and inbox (steers, follow-ups, writes)
- generation and tool tasks with checkpoints, and replay-safe versus unsafe
  tools
- retries, abort, task ownership, and subagents
- a committed live view that clients can join late

It keeps all of this in a storage it opens itself, and its scheduler runs in
memory. It cannot wake an evicted Durable Object, and it has no Durable
Object storage backend. Rebuilding its logic in the Agents SDK would create
two competing authorities for the same effects.

The first version of this example (#2210) wrapped pi-agent-core's older
`AgentHarness` with `Tasks`, `Streams`, and an intake table. pi-durable
replaces that API, and most of the wrapper with it.

## The proposal

Prove the composition as an example first. `examples/next/harnesses/pi`
hosts pi-durable on a plain Durable Object:

```ts
readonly harness = new PiHarness({ models, model, tools });
readonly sockets = new PiSessionSockets(this.harness, (tag) => this.ctx.getWebSockets(tag));
readonly webSockets = new WebSockets(this.sockets.options());
readonly lifecycle = Lifecycle.install(this)
  .use(this.webSockets)
  .use(this.harness);
```

`PiHarness` and the session store are example-local code.
Nothing in this RFC adds an export to the `agents` package.

Responsibilities are split by authority:

- **pi** owns everything about a run: the transcript, inbox, tasks, tool
  replay, retries, abort, and the live view. It stores them in its own schema
  through its portable `SqliteStorage`.
- **The session store** (`session-store.ts`) is pi's `SqliteDatabase`
  facade over `ctx.storage.sql`. Transactions use `transactionSync`, and
  pi's tables are moved under a `pi_` prefix. pi's own storage conformance
  suite runs against it on a real Durable Object.
- **The wake** is one Lifecycle job per session, owned by `PiHarness`. Input
  goes to pi once, in `submit()`, after the session's job is scheduled. The
  job only checks on pi: while pi has live tasks in the session it stays due
  on a heartbeat, and it completes when there are none, or as soon as pi's
  idle promise resolves. A restart mid-run leaves it due, so its alarm
  restarts the object and pi resumes its own tasks. The wake never admits
  input, replays model or tool work, or holds a timer of its own.
- **Transport is app glue**, not part of the harness. The harness exposes
  `session.events()`, which is pi's own agent events: a snapshot, then one
  batch per commit. The example's `sockets.ts` puts one session per socket on
  `WebSockets`. There is no cursor or replay log. A client that joins or
  reconnects gets a snapshot.

`examples/next/harnesses/pi/NOTES.md` explains why a Lifecycle job was chosen
over Tasks, the driver, and the state machine, and records everything that was hard.

## Known costs

- Background pi tasks are polled every 30 s, because the conversation's idle
  wait ignores them.
- pi sleeps with `setTimeout`. A pending timer keeps an object in memory
  for at most 15 minutes and is lost on a restart, so long waits of the
  generation task become wake-job reschedules by reading pi's `LiveDoc`;
  custom task sleeps are invisible. This needs a pi change.
- Two reads (`submissionByRequest`, `scanConversations`) go to pi's storage
  directly, because the Harness does not offer them.
- The table prefix is a SQL rewrite, because pi has no prefix option.
- The build pins pi `main` (2bbfcca4) as vendored archives. The npm 0.99.1
  release predates pi-durable's inbox, events, and subagents.

## Before this becomes a package export

- A pi release with pi-durable Packages 17–19, so no archives are vendored.
- Upstream asks: scheduler-owned sleeps with a next-wake time on
  `inspect()` (or an injectable timer), submission lookup by request id,
  conversation listing, and a table prefix.
- Compaction upstream, and an `ExecutionEnv` for pi's coding tools on
  Workspace or a Container.

## Alternatives

- Keep driving pi from `Tasks` (#2210). Rejected: Tasks journals steps for
  replay, pi is the replay authority, and capability-owned Tasks drivers
  need private apertures.
- Drive pi from the driver (#2396). Rejected: with pi owning admission and
  replay, the driver reduces to one heartbeat job per session, which
  Lifecycle jobs already are.
- Drive pi from `agents/state-machine` (#2338). Rejected: pi-durable's
  scheduler leaves nothing to drive in passes, and child machines overlap
  with pi's own task ownership.
- Ship `agents/harness` now. Rejected until the items above land.

## The decision

Pending experience from the example.
