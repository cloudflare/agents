Status: proposed

# Pi AgentHarness as a Lifecycle capability

## The problem

Pi's `AgentHarness` has the operation state machine we need for durable model
and tool execution. It does not own platform storage or scheduling. Rebuilding
its transcript, tool-intent, and crash-recovery logic in the Agents SDK would
create two competing authorities.

## The proposal

Export `PiHarness` from `agents/harness` as a Lifecycle capability:

```ts
readonly pi = new PiHarness(config);
readonly lifecycle = Lifecycle.install(this).use(this.sessions).use(this.pi);
```

Each Durable Object owns one pi Session, and that Session is stored in the
`agents/sessions` capability the host already composes: `PiHarness` implements
pi's `Storage` contract over the `cf_agents_session_*` tables rather than a
vendored SQLite backend of its own. Entries and the usage ledger are rows of
`cf_agents_session_messages` (its `type` column carries pi's entry kind);
values and list elements are keys in `cf_agents_session_config`. Payloads that
would otherwise sit inline — prompt and tool images — ride the capability's
attachment offload path. There is one message store per object: no second
schema, no new table, and no index.

- **Alternative considered.** Keep pi's `@earendil-works/pi-session-backend-sqlite-node`
  behind a Durable Object SQLite shim (the v0.1 implementation): 7 tables,
  6 indexes, and a transcript no other capability can read. Rejected once
  `agents/sessions` had the same tree-structured entry model, because two
  message stores in one object is the cost, and pi ships a runner-independent
  conformance suite that makes the adapter's correctness checkable.

Pi remains authoritative for operation acceptance, transcript state, provider
attempts, tool intent and settlement, retry waits, and recovery. Lifecycle jobs
only provide durable wakes. `submit()` writes the wake before asking pi to
accept the operation, so a crash cannot leave accepted work without a wake.
`prompt()` is the waiting convenience over the same path.

Tool code is process-local. `config.tools` may be a callback and is resolved
before each operation that owns its lane. `config.configure` rebuilds pi hooks
after each isolate wake. Tool functions are never stored.

The v0.1 wrapper supports string prompt operations. `prompt()` returns the
operation outcome and display-ready messages, while `getMessages()` reads that
stable projection without another model turn. Raw entries and terminal results
remain available through pi-aligned `findEntries()` and `getResult()` methods.
The Workers AI adapter is
exported separately from `agents/providers/pi`, keeping the harness
provider-independent. More operation kinds and a client transport can be added
after this path has real users.

Until pi publishes the completed harness, the build pins
`earendil-works/pi@c4b0e35a`. The required MIT-licensed runtime is bundled into
`agents/harness`; it is not installed by SDK consumers.

## Alternatives

- Reimplement execution on `Tasks`. Rejected because Tasks and pi would both
  own replay and effect recovery. Lifecycle jobs are enough for wake delivery.
- Wrap pi's older in-memory `Agent`. Rejected because it would require another
  transcript and recovery implementation.
- Wait for the next pi release. Rejected for this experimental v0.1; replace the
  vendored build when a release contains the completed harness.
- Keep pi's vendored SQLite session backend. Rejected: see the storage note
  above.

## The decision

Pending experience from the v0.1 implementation and eviction tests.
