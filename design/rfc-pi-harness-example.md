Status: proposed

# Pi AgentHarness as a Lifecycle capability

## The problem

Pi's `AgentHarness` has the operation state machine we need for durable model
and tool execution: transcript, tool intent and settlement, retries,
cancellation, and crash recovery. It does not own platform storage, scheduling,
or client transport. Rebuilding its logic in the Agents SDK would create two
competing authorities for the same effects.

## The proposal

Prove the composition as an example first. `examples/next/harnesses/pi` hosts
pi's harness on a plain Durable Object using only the SDK's existing durable
primitives:

```ts
readonly tasks = new Tasks();
readonly streams = new Streams();
readonly harness = new PiHarness({ models, model, tasks, streams, tools });
readonly webSockets = new WebSockets(this.harness.webSockets());
readonly lifecycle = Lifecycle.install(this)
  .use(this.tasks)
  .use(this.streams)
  .use(this.webSockets)
  .use(this.harness);
```

`PiHarness` is example-local code. Nothing in this RFC adds an export to the
`agents` package.

Responsibilities are split by authority:

- **Pi** owns operation acceptance, transcript state, provider attempts, tool
  intent and settlement, retry waits, and recovery. Its session is stored in
  this object's SQLite database through a small adapter that namespaces pi's
  tables under `cf_agents_pi_*`.
- **Tasks** delivers durable wakes. Each lane's work is one Task run whose
  journaled steps drive pi to settlement and replay after eviction. Tasks
  never re-executes a model or tool effect itself; pi's session is the
  recovery evidence.
- **Streams** is the durable output log. Every operation's live events land in
  one stream, batched per chunk, so a client replays then tails from its
  cursor.
- **WebSockets** serves the browser protocol: a lane snapshot on connect,
  `subscribe` to replay-then-tail an operation stream, and `submit`, `abort`,
  and `steer` to drive it.
- **Skills** from `agents/skills` become pi resources plus `activate_skill`
  and `read_skill_resource` tools, the same tools `@cloudflare/think` offers.

Submission is durable before the caller sees a receipt: `submit()` writes an
intake row and enqueues the lane driver before pi accepts the operation, so a
crash cannot leave accepted work without a wake.

## Known costs

- The pi session adapter carries pi's own schema: seven tables and their
  indexes. Once `agents/sessions` (#2196) lands, pi's `Storage` contract
  should be implemented over the sessions tables instead, leaving one message
  store per object.
- The harness uses the framework-internal Tasks apertures (`register` with a
  reserved name and the queued enqueue). A public way for a capability to add
  a driver to host-owned Tasks is still to be designed.
- The build pins an unreleased pi commit (`c4b0e35a`) as vendored archives.
  Replace them with published versions when a pi release contains the
  completed harness API.

## Before this becomes a package export

- `agents/sessions` merged, and pi's session stored there.
- A pi release with the harness API, so no vendored archives ship.
- Public Tasks support for capability-owned drivers.
- Eviction and recovery tests promoted from the example into the package.

## Alternatives

- Reimplement execution on `Tasks` steps. Rejected because Tasks and pi would
  both own replay and effect recovery.
- Wrap pi's older in-memory `Agent`. Rejected because it needs another
  transcript and recovery implementation.
- Ship `agents/harness` now. Rejected until the items above land; the example
  lets the composition get real use without committing the package API.

## The decision

Pending experience from the example.
