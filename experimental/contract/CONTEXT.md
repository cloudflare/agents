# Contract — composable Agents SDK rebuild

The ubiquitous language for the `experimental/contract` package: the domain
interfaces for the composable rebuild. This file is a glossary only — it names
what each concept IS. Dependency rules, the residue model, and open questions
live in `README.md`; implementation lives nowhere yet (the package is types).

## Language

### External lifecycle

**ExternalResource**:
Something with a lifecycle the log cannot replay back into existence — a
browser session, an MCP connection and its OAuth token, a sandbox, a child
agent, a running workflow instance. The log records a reference to it; only
the resource itself can revive it (`ensure()`).
_Avoid_: Resource (too generic; collides with Workers bindings/KV/D1/R2 which
are the opposite — things the platform hands you already alive),
ResourceAttachment (names the mechanism, not the thing), Attachment, Handle.

**ExternalResource health** (`ready` | `degraded` | `gone`):
The liveness report an ExternalResource gives when asked. `ready` = use it;
`degraded` = usable but wounded; `gone` = dead, must be revived before use.

### Channels (how work gets in and out)

**Channel** (uses RetryContract, defined under Tools):
A bidirectional adapter between the log and an external surface (WS chat,
Telegram, email, cron, workflow callbacks, a parent agent's RPC). "Everything
that gets work in is a channel" — the single abstraction that replaces the
current five-plus entry paths.
_Avoid_: ChannelAdapter (drops the GoF pattern suffix; the domain noun is the
channel, not the adapter), entry path, transport.

**Inbox**:
The narrow door through which a channel submits inbound entries to the log.
Its one job is `submit()`, and append-with-idempotency makes it the durable
inbox — there is no separate inbox subsystem or queue.
_Avoid_: InboundGateway, Gateway (overloaded: API/payment gateway), EntrySink.

**Outbox**:
The outbound half of a channel: which consumer to read, which entries to
filter for, the DeliveryContract to honor, and the `deliver()` that pushes
entries to the external surface. The engine owns cursors, retries, and
redelivery; the outbox owns only the last mile.
_Avoid_: OutboundSpec ("Spec" is filler), Delivery.

**RetryContract** (`at-least-once` | `at-most-once`):
One shared type used by BOTH channel outboxes and tool effects, answering the
same question in the same words: is repeating this last-mile action safe? The
engine always runs handlers at-least-once (residue 2), so every last-mile
actor declares whether that is safe.
- `at-least-once`: repeating is safe. HOW it stays safe is the actor's own
  business — rely on natural idempotency, or thread a dedupe key (the
  channel's `ctx.dedupeKey`, or a tool effect's optional `key(input)`). The
  engine treats those the same.
- `at-most-once`: repeating is NOT safe and a duplicate is worse than a loss,
  so the engine acts once and never retries after failure. For a tool effect
  this is the "none" case — the reconciler surfaces ambiguity rather than
  silently re-executing.
_Avoid_: DeliveryContract (too channel-specific — a tool effect does not
"deliver"; RetryContract fits both), DeliveryGuarantee, dedupe-key /
idempotent-receiver / natural / keyed as separate enum variants (collapsed —
those differ only in the actor's own implementation, not engine behavior).

An Outbox declares its RetryContract (above); the engine honors it.

### Turns, steps, and the kernel vocabulary

**Turn** (formerly Run):
One admission of work — the sequence of steps from a trigger entry until
quiescence. The human/telemetry envelope over a sequence of steps ("this turn took
4 steps and 12s"). Execution and durability are per-STEP, not per-turn; the
turn is the reporting/concurrency-control unit that admission acts on
(start/resume/queue/merge/preempt). `TurnStatus`: `active | parked |
completed | failed`.
_Avoid_: Run (chosen originally for medium-neutrality, but the team says
"turn"; familiarity won — the chat connotation is tolerable because the turn is
the human envelope, while the rigorous medium-neutral unit is the Step).
Rename blast radius (schemas-are-forever): `RunId`→`TurnId`,
`RunStatus`→`TurnStatus`, `RunInfo`→`TurnInfo`, `run/marker`→`turn/marker`,
`RunMarkerPayload`→`TurnMarkerPayload`, `RunFailureNotice`→`TurnFailureNotice`,
and every `.run` field → `.turn`.

**Step**:
The rigorous execution + durability unit: one `AgentLoop.step()` the harness
commits atomically. All medium-neutral rigor lives here (this is why the Turn
is free to take the human word). At most one open step per branch. Turn-level
and step-level status words deliberately RHYME (`parked`/`completed`/`failed`
appear at both levels — a turn is parked because its current step parked).

**Quiescence** (a TURN property — distinct from *settled*):
The state a turn reaches when it is no longer actively stepping. Two flavors:
- TERMINAL quiescence: `completed` or `failed` — the turn is over.
- SUSPENDED quiescence: `parked` — the turn is alive and sleeping, resumable
  when a correlated entry arrives.
Admission's `queue` holds new work "until the active turn reaches quiescence."

NOT the same as **settled**, which is an EFFECT property (a single Ledger claim
reaching a terminal `SettleOutcome`). Different levels: settled = one external
action resolved; quiescent = one turn not stepping. They can diverge — a
`parked` turn is quiescent WHILE holding unsettled (open) effect claims;
indeed an open claim is usually WHY it parked. That divergence is exactly why
parked turns need the Reconciler backstop: if the outstanding effect never
settles, the reconciler forces it terminal so the turn can resume or die
instead of sleeping forever.

**Versioned** (envelope + tolerant-reader rule):
Every durable payload carries `kind` (namespaced `"<module>/<name>"`) and `v`
(schema version). The RULE is the domain knowledge (residue 5, schemas are
forever): readers MUST skip unknown kinds, ignore unknown fields, and surface
a newer `v` as opaque rather than erroring. This is what makes private
pass-through entries and cross-version replay safe.

**RetryPolicy**:
A bounded-retry DECLARATION (residue 4), not machinery. Domain, not generic:
`maxNoProgressMs` (#1637) and `maxOomAttempts` (#1825) encode years of
incident learning; defaults are mined from production constants. A
constraint-not-visible-in-code worth preserving by name.

### Admission (the gate to running work)

**Admission**:
The single gate between "an entry was committed" and "a turn does work about
it." Asked once per trigger entry, it decides how that entry affects the turn
lifecycle. Pure decision logic — no timers, storage, or execution; the runtime
enforces the verdict, and it must be re-runnable (same inputs → same answer).
The bouncer at the door: it admits, queues, merges, preempts, or turns away a
turn.
_Avoid_: RunScheduler / SchedulingPolicy (implies timers/ordering machinery
this explicitly is not), entry path, dispatcher.

**AdmissionPolicy**:
The declaration a definition supplies for its Admission gate: a `triggers`
pre-filter (which entry kinds are even candidates) plus `decide()`. `Policy`
is earned here — it is domain knowledge the runtime enforces, alongside
RetryPolicy and LoopPolicy.

**Trigger** (entry):
An entry that can cause a turn to start or resume. `triggers` pre-filters the
log down to trigger candidates so everything else is cheaply ignored.

**AdmissionDecision** — the six verbs, each a decision about turns:
- `start`: a fresh request arrives and nothing is running → begin a new turn.
- `resume`: the thing a parked turn was waiting for lands (tool result,
  approval verdict, sub-agent completion) → wake that turn. THIS is the
  replacement for auto-continuation-as-a-subsystem: resumption is just another
  entry hitting the same gate.
- `queue`: a new request arrives while a turn is active → hold it as a pending
  turn until the active one reaches quiescence.
- `merge`: another request arrives while one is already queued → fold it into
  the queued turn instead of stacking a third (rapid-fire message merging).
- `preempt`: the in-flight turn is now stale (latest-wins) → abort the active
  turn and start over with the new entry.
- `ignore`: not a trigger (the agent's own bookkeeping entries) → no turn
  implications.
_Avoid_: `continue` for the resume case (collides with `loop`'s StepOutcome
`continue`, which means "take another step"; a parked turn is *resumed*).

### Context (what the model sees)

**Context**:
The material assembled for the language model to see on a given step — the
constructed view of history plus system prompt, tools, and budget. This is the
SAME "context" as the LLM context window (the window is where the context
goes) and as "context engineering" (engineering this material). One strong,
coherent domain meaning; it is NOT the generic "ambient bag handed to a
callback" sense.
_Avoid_: prompt (a prompt is the opening user message — a part of the context,
not the whole), and using "context" for the per-call handler bags (those are
the overloaded offenders and get renamed — see below).

**ContextAssembler** / **assemble**:
Builds a `LanguageModelRequest` from committed state: transcript view in,
request out. Truncation windows, sliding windows, drop-oldest, intelligent
slicing, RAG, capability blocks, scratchpads — every context strategy is just
an implementation. There is NO privileged answer to an overfull context: the
answer is simply to assemble a smaller view.
_Avoid_: PromptAssembler / RequestAssembler (see "prompt" above).

**Purity boundary (corrected)**: `assemble()` itself is a pure, deterministic
read — view in, request out, NO writes during assembly — so it is safe to
re-run when a step re-runs (residue 2). But a ContextAssembler as a COMPONENT
is NOT stateless: a compacting assembler emits its own summary-overlay entries.
That writing must happen on a SEPARATE, explicit, idempotent path (not inside
`assemble()`), or a step re-run would double-write the summary. Likely wants
its own emit seam (e.g. a `compact()` distinct from `assemble()`) — a
design-phase call. The old "pure function, nothing durable" framing was only
true when the engine did the writing; it is false now.

**`...Context` bags** — RENAME PENDING (not this file's concern):
`StepContext`, `ToolExecutionContext`, `ReconcileContext`, `DeliveryContext`
use "context" in the generic "ambient stuff for one call" sense, diluting the
strong domain meaning above. Rename them so "context" stays reserved for what
the model sees. Precedent set: `ToolExecutionContext` → `ToolExecutionDeps`
("Deps" = injected dependencies). Apply the same `...Deps` treatment to the
rest as each file is reviewed (`ReconcileDeps`, `DeliveryDeps`, `StepDeps` —
confirm per file).

**Compaction is NOT a contract concept** — removed from `context.ts`.
Compaction (durably summarizing old history) is just ONE `ContextAssembler`
implementation, living in its own module. It reads a fuller view, emits its
own private namespaced entries (`"<its-module>/summary-overlay"`), and resolves
them back on later reads. Because it needs no top-level type, the contract has
no `CompactionStrategy` / `CompactionPlan` / `CompactionPressure`.
_Consequence to review at `transcript.ts`_: the engine's compaction-awareness
(`CompactionPayload` reserved kind, `ReadOptions.compacted` flag) should
likely be REMOVED — the engine need not know compaction exists. BUT this is
only safe if the read API preserves the performance the overlay gave (see
open question on transcript reads).

**Private pass-through entries** (extensibility pattern, not a type):
Because entry `kind` is open and namespaced and readers are tolerant (unknown
kinds skipped), any module may emit its own entries that flow transparently
through the log — every other module ignores them — and read them back later as
private vocabulary between the module and its future self. A compacting
assembler emitting summary-overlay entries is the canonical example. This is
the mechanism behind "an extension is just another bus client."

### The language model

**LanguageModel**:
The seam to the LLM: one request in, one output out. Deliberately narrow —
no internal tool loop, no `maxSteps`, no `prepareStep`. Iteration belongs to
the loop; this interface only translates our Part vocabulary to a provider
(AI SDK, direct API, …), streams chunks back, and classifies its own errors.
A single invocation = one atomic step the engine can retry whole.

**Adapter internal-loop boundary**: a `generate()` implementation MAY
internally do multiple inferences or call server-side read-only tools (an
agentic/"deep research" provider endpoint is a valid `LanguageModel`) — how it
produces its output is invisible to the contract. The one hard rule: it must
NOT perform MUTATING effects internally (no sending email via a server-side
tool), because anything done inside `generate()` bypasses the Ledger
(residue 1). Read-only inner tools are fine (nothing to reconcile); mutating
ones are a durability hole. This is the whole content of the old "pure/read
inner tools only" flag — a safety boundary on the one seam, not a second seam.
_Avoid_: Model (too generic — could be an embedding/rerank/classifier model;
this is specifically the generative text model the loop drives), ModelPort
(hexagonal-architecture jargon, inconsistent with the rest of the package),
ModelProvider, ModelClient.

**LanguageModelOutput**:
What a single LanguageModel invocation returns: the assembled parts, a finish
reason, and usage. The loop decides this output constitutes a step — the model
itself does not know about steps.
_Avoid_: ModelStepOutput (leaks the loop's "step" concept into the model),
ModelResponse.

**LanguageModelErrorKind** (`context-overflow` | `rate-limit` | `transient` |
`fatal`) / **classifyError**:
The obligation that a LanguageModel classify its own failures into kinds the
loop can act on (overflow → compact & retry; transient/rate-limit → retry per
policy; fatal → fail the step). Replaces regex-over-error-message strings with
a first-class port obligation — domain knowledge pushed to the one adapter
that actually knows what each provider error means.

(General LLM concepts — `FinishReason`, `LanguageModelStreamChunk` deltas,
`TokenBudget`, `JSONSchema` — intentionally kept ecosystem-standard and NOT
glossary terms.)

### Tools (capabilities the model can call)

**ToolProvider**:
What a capability author writes: `catalog()` of descriptors, `execute()` for a
call, and any ExternalResources it depends on. Browser, computer-use, MCP,
workflows, subagents are all providers. A provider NEVER writes claim/settle —
its entire durability obligation is an honest EffectDeclaration per tool plus
an ExternalResource for external lifecycles.
("Capability" is a design-doc concept for everything the harness can do; it is
out of this contract's domain — the contract vocabulary is "tool.")

**ToolMiddleware**:
A cross-cutting wrapper `(next: ToolProvider) => ToolProvider`: approval/HITL
gate, x402 payment, telemetry, allow/deny. Composition order is authority
order. The one GoF-pattern word kept, because "middleware" is universally read
as exactly this shape.

**ToolRuntime**:
What the loop calls. The single merged catalog PLUS everything the execution
engine layers on — `execute()` runs approval → claim → provider.execute →
settle once, generically, so duplicate calls (step re-runs, recovery) hit the
claim and return the recorded result. "Runtime" is earned: it is not just the
tools, it is the tools with runtime concerns applied.
_Avoid_: Tools / Toolbox (implies only what providers returned, not the engine
layer).

**EffectDeclaration**:
The durability facts a tool declares so the runtime can run claim/settle
generically. A wrong declaration is the one durability bug the framework cannot
catch (residue 1 as a declaration). Fields:
- `effect`: `"readonly" | "mutating"` — the one bit the runtime needs: does
  this change the world (claim first) or not (replay-safe, no claim)? A union
  of two, not a boolean, so a third can be added later. Collapses the old
  `pure`/`read`/`write`: pure and read were identical to the runtime.
- a RetryContract (only meaningful when `mutating`) + optional `key(input)`.
_Avoid_: `clazz` (keyword-dodge for a field that was never really a "class");
`pure`/`read`/`write` as three durability values.

**ToolExecutionResult** (provider-side: `completed` | `pending` | `failed`):
What `ToolProvider.execute()` returns — the RAW result BEFORE the runtime
resolves it. The provider has no concept of settle.
- `completed`: answer is ready now (`getWeather` → `{temp:72}`).
- `pending`: the effect outlives this call; a correlated entry will settle it
  later (spawn a subagent, start a workflow, a long tool). Tool-out /
  entry-back is the ONE async pattern; sync completion is its fast path.
- `failed`: this attempt failed (`retryable` says whether to try again).

**ToolOutcome** (runtime-side: `settled` | `pending` | `awaiting-approval`):
What `ToolRuntime.execute()` returns to the loop — the RESOLVED verdict AFTER
approval + claim + settle ran. Sits in the package's `-Outcome` family
(SettleOutcome, ReconcileOutcome). The result/outcome pairing is the teaching
distinction: a `Result` is the provider's raw return; an `Outcome` is the
runtime's resolved verdict.
- `settled`: the effect reached a terminal outcome — success OR error, both
  carried by `result: SettleOutcome`. There is no separate success member;
  by the time the runtime returns, every terminal result has been settled.
  `attempt: number` (1-based) records fresh (1) vs replayed (>1) for
  telemetry — a count, matching the `attempt` pattern used on DeliveryContext,
  ReconcileDeps, and TurnInfo. The loop continues.
- `pending`: claim recorded, effect in flight → the loop PARKS.
- `awaiting-approval`: approval gate tripped → the loop PARKS until the verdict
  entry lands.
_Avoid_: GatedToolResult (undersells — implies only the approval gate, not
claim/settle/replay), ToolExecutionRuntimeResult (too long); `completed` +
`settled` as separate members (collapsed — the loop treats them identically;
fresh-vs-replay is the `attempt` count, not a member); `replayed: boolean`.

**Approval** (`ApprovalRequirement` / `ApprovalDescriptor`, modes
`always` | `never` | `policy`):
The HITL vocabulary. A tool's `ApprovalRequirement` says whether it always,
never, or by-policy needs sign-off; `ApprovalDescriptor` (title/detail/input)
is what the human sees. The approval LIFECYCLE spans three files: requirement
declared here → `awaiting-approval` ToolOutcome parks the turn → the verdict
entry landing is a trigger that `resume`s it (admission).

**ToolExecutionDeps**:
The dependencies injected into one tool execution — the run, correlation,
abort signal, `putBlob`. "Deps" (injected dependencies), not "context": this is
the first of the `...Context` bag renames, keeping "context" reserved for what
the model sees.
_Avoid_: ToolExecutionContext, ToolExecutionScope.

### The loop (agentic strategy) and the harness that drives it

**Harness** (`drive(deps: TurnDeps): Promise<void>`):
The thing that takes a turn and carries it to quiescence — it owns the
while-loop, iteration, and the commit boundary. We ship a DEFAULT harness; a
user may bring their own (Pi, opencode, a Claude/Codex loop). This is THE
seam, not a special foreign case: our step-loop is just the harness that ships
in the box, and a third-party loop is a peer, not a deviation. ONE unified
interface — the default step-harness and a foreign harness satisfy the SAME
type; the difference is behavioral (commit GRANULARITY), not structural (never
a different injected surface, never an `if (foreign)` branch).

Called FRESH per wake (A1): a parked turn holds NO in-memory state, so every
wake is a new `drive()`; the harness rehydrates from `deps.view`. It is not
handed *why* it woke — the log is the snapshot: the harness reads the tail
(latest `turn/marker`), `openClaims()` (what it was waiting on), and the newest
correlated entry (the trigger that settles it). A harness needing an
idiosyncratic wake signal writes its own private pass-through entry and reads
it back next wake — no new type.

`drive()` returns **`Promise<void>`**: the harness's contract is to leave the
log QUIESCENT — commit a terminal (`completed`/`failed`) or suspended
(`parked`) `turn/marker` — and the runtime learns the outcome by reading that
marker off the tail, like any other cold reader. No `Quiescence` return type
(the log carries it); no `resume()` method (A1 — one `drive()` handles start and
resume, distinguished by reading the view).

Whichever harness is in play OWNS DURABILITY for the turn, expressed by commit
GRANULARITY through the shared `commit`: the default commits once per step
(full residues); a foreign harness commits once per span, or at its own
checkpoints (durability peer, not client — residues delegated to it). The type
makes you pick knowingly because the granularity is yours to choose.
_Avoid_: RunDriver / Driver (would make "our loop" privileged and BYO a
second-class escape hatch — Harness treats them as peers), RunEngine (collides
with the transcript "engine"). Faint "test harness" connotation is tolerable;
`AgentHarness` disambiguates if ever needed.

**TurnDeps** (the injected surface for one `drive()`):
The purpose-built, deliberately NARROWED surface a harness is handed to drive
one turn/one wake — NOT the full Engine. Members:
- `turn: TurnInfo` — identity (which turn/branch), not situation (why is in
  the log).
- `view: LogView` — read the tail / `openClaims` / correlated entries to
  rehydrate; also resolves `getBlob` (reading bulk is part of reading).
- `commit(entries): Promise<refs>` — the STEP-AGNOSTIC atomic append (folds
  entries + marker in one transaction; `putBlob` pairs with it, since writing
  bulk is part of writing an entry). The shared commit primitive; "Step" is one
  harness's way of USING it, not part of the seam.
- `write(chunk): void` — step-agnostic live streaming of ephemeral LiveChunks.
- `tools: ToolRuntime` — always present, always governed (claim/settle behind
  it). A harness MAY add its own tools ON TOP, but those are additive and
  UNGOVERNED; runtime tools are the encouraged default, so the durable path is
  the easy path.
- `signal: AbortSignal` — preempt/cancel.
Deliberately EXCLUDED (kept behind the runtime/substrate): `fork`, `consumer`
registration, `reconciler` registration, raw un-committed `append`, and
`Ledger` (claim/settle is reachable ONLY through `ToolRuntime` — a harness
cannot half-use the ledger; its own effects are the ungoverned ones by
definition).
_Avoid_: passing the whole `Engine` (violates "receive only the sub-modules you
need"); a `trigger`/`resumeEntry` parameter (the trigger is the newest
correlated entry on `view` — the log is the snapshot); `StepHandle` in the
shared surface (default-harness-internal, see Step below).

**AgentLoop** / **step**:
The step-strategy the DEFAULT harness consumes — one step of "what to do next":
ReAct, plan-and-execute, reflection, tree search, each an implementation of
`step()`. NOT "the loop": it is an implementation detail of the default
harness, one level below the Harness seam. A foreign harness has no AgentLoop
at all (it brought its own iteration). The step collapses the old 900+-line
inference loop because everything it used to gather arrives pre-composed in
StepDeps.

**Step** (DEFAULT-harness-internal commit unit) and its outcomes (`continue` |
`completed` | `parked` | `failed`):
A `Step` (and its `StepHandle`: open → `write`* → commit-with-marker) is the
DEFAULT harness's way of using the shared `TurnDeps.commit`/`write` primitives
— NOT part of the Harness seam. It bundles the default harness's own rules
(single-open-step-per-branch invariant, `turn/marker` stamping). A foreign
harness has no Step at all — it commits at its own granularity through the same
`commit`. One step = one `AgentLoop.step()` the default harness commits
atomically. Outcomes:
- `continue`: committed; drive the next step. (Distinct from admission's
  `resume` — continue = keep looping; resume = wake a sleeper. This is why
  admission's verb was renamed.)
- `completed`: the turn is finished (final answer committed). Renamed from
  `done` to match `TurnStatus: "completed"`.
- `parked`: the turn sleeps with NO in-memory state, waiting on the outside
  world (approval, pending effect, client tool); a correlated entry re-admits
  it via `resume`. The eviction-safe replacement for durable-pause, detached
  turns, and auto-continuation all at once. New at the turn level — the
  higher-level sibling of a tool's `pending`.
- `failed`: retryable per policy (transient model error, stall).
_Avoid_: `done` (use `completed`).

**StepDeps** (= `TurnDeps` ⊕ the default harness's brain):
The composed world one step operates in. It is exactly `TurnDeps` (`view`,
`commit`/`write`, `tools`, `turn`, `signal`) PLUS the fields `stepHarness`
closed over (`model`, `context`, `loop`). This superset relationship is the
bridge between the Harness seam and the default loop: the step sees the turn
surface plus the default harness's thinking. Only the default harness has a
`StepDeps` (a foreign harness has no `AgentLoop`, hence no StepDeps). `Deps`,
not `Context` (frees "context" for what the model sees).
_Avoid_: StepContext.

**LoopPolicy** (`maxSteps` / `retry` / `stallTimeoutMs`):
The default harness's per-turn execution policy (residue 4, the `...Policy`
family). `maxSteps` is the HARNESS's step cap — note the loop owns step-count,
not the language model (whose internal `maxSteps` was rejected).

**TurnFailureNotice** (reasons `exhausted` | `aborted` | `fatal`):
The `failed` `turn/marker` a harness commits when a turn dies abnormally, so a
client sees a terminal state instead of an eternal spinner (the incident-
learned "exhausted" banner). `exhausted` = out of retries/steps; `aborted` =
preempted/cancelled; `fatal` = unrecoverable. Because `drive()` returns `void`,
the failure REASON lives here (in the marker the harness commits), not in a
return value — the harness reports failure by committing this marker; the
runtime renders the terminal banner from it. The harness owns the reason; the
runtime owns the presentation.

### The spine: Log, Engine, and its deep sub-modules

**Log**:
The durable, ordered, branch-aware sequence of Entries — everything that
happened to the agent. It is DATA: you read it, it has no behavior. Chat-free
by design (messages are just one entry kind among effects, run-markers, etc.),
so the recovery story can be stated with no chat vocabulary.
_Avoid_: Transcript (connotes a conversation record — undersells a log that
holds effects/markers/bookkeeping, and re-imports the chat vocabulary the
design escapes; survives only as informal prose), EventLog, Journal, Ledger
(the ledger is a specific sub-part, see below).

**Engine**:
The behavioral service that OWNS the Log: appends, begins steps, claims/
settles, reconciles, streams live output, forks branches. Distinct from the
Log (data) — the split is enforceable by type: read-only clients get a LogView,
the harness/runtime gets the Engine. NOTE: the Engine is not one deep module
but a STACK of them (see ADR 0001) — "Engine" is the composition, and callers
receive only the sub-modules they need.
_Avoid_: Transcript (was both data and service — the conflation this split
fixes), Runtime, RunEngine.

**LogView**:
A read-only projection of one branch's committed entries — what pure-read
clients (context assemblers, reconcilers, every harness's rehydrate) receive.
Holding an Engine where a LogView suffices is a design bug. Surface:
`branch`, `head()`, `get(id)`, `getBlob(ref)` (reading bulk is part of
reading), and ONE read primitive `query(q: Query): Promise<readonly Entry[]>`.
- Results are ALWAYS NEWEST-FIRST — there is no direction knob. "Latest entry
  of kind X" (the self-resume requirement) is just `{ kinds:[X], limit:1 }`;
  the performance-critical query is the simplest query. Chronological
  consumers (assemblers) reverse a bounded result in memory — the view does
  selection, not presentation; it never emits oldest-first.
- Returns a finite ARRAY, not an AsyncIterable — because bounded-always (see
  Query). No streaming/backpressure on the normal surface; unbounded
  traversal is a separate deliberate escape hatch (LogExport, below).
_Avoid_: TranscriptView; a `read()` AsyncIterable (bounded reads return
arrays); baking `latest`/`after`/`until`/`filter` as first-class METHODS
(access patterns are Query values, not methods).

**Query** (the value LogView.query interprets):
A closed struct of INDEXABLE dimensions — NOT an open predicate — so every
expressible query is index-served, never an in-memory scan. That is what lets
"deep module, small interface" and "cheaply find latest-of-kind" coexist. New
access patterns are new field combinations, not new methods. Fields (all
optional): `kinds?` (namespaced), `correlation?`, `turn?`, `after?` (seq floor,
EXCLUSIVE — the resume cursor), `before?` (seq ceiling, exclusive), `limit?`
(count cap, newest-first).
- BOUNDEDNESS INVARIANT: at least one of `{after, before, limit}` must be
  present. A fully-unbounded query (none of them — "the whole branch") is
  rejected at runtime. `limit` is OPTIONAL, not required: "everything since the
  last compaction marker" is `after`-bounded with no known count; a
  `before`+`after` window is range-bounded. `limit`-required was wrong — it
  conflated count-bounded with bounded.
- The invariant is STRUCTURAL ("a bound exists"), not SEMANTIC ("the result is
  small"). `after: <recent marker>` is cheap; `after: 0` is the caller shooting
  itself — the log trusts the caller's bound; tightness is the caller's job.
  Not worth type-contorting to prevent, since `after:0` trivially defeats any
  guardrail anyway.
- Preferred ergonomic surface is a small set of CONSTRUCTOR functions that each
  produce a valid bounded Query (raw struct stays internal): `since(seq)`,
  `between(after, before)`, `latest(kind, n?)`, `window({...})`. The named
  access patterns we enumerated become the readable interface; Query stays the
  closed representation.
_Avoid_: an open predicate `(entry) => boolean` (un-indexable — the trap that
makes a Query value shallow); a `direction` field (newest-first always);
`originModule` (no reader needed it — re-add as a field if one appears, which
is exactly what a closed struct makes cheap).

**LogExport** (`scan(branch, from?): AsyncIterable<Entry>`):
The DELIBERATE full-branch traversal for export / debug / migration ONLY —
unbounded, streamed, and OLDEST-FIRST (the one place oldest-first exists,
because export wants chronological order). NOT on LogView and NOT in TurnDeps
(a harness never exports); it lives on the Engine/substrate side. Kept visibly
separate and obviously-expensive so the normal bounded newest-first `query()`
is the habitual path and "scan everything" is a named exception nobody reaches
for by reflex.

**Entry** / **NewEntry**:
One committed record on the Log (`ref`, `at`, `origin`, optional `run`/
`correlation`, `payload`). `NewEntry` is the proposed form before the Engine
stamps `ref`/`at`. "Everything is an entry on the log" is the core framing.
Kept verbatim.

**Part** / **Role** / **MessagePayload**:
The reserved `"message"` core kind — the ONE place chat vocabulary legitimately
lives. Note there are THREE distinct "piece of model output" vocabularies,
intentionally not merged because they serve different layers: `Part`
(committed payload), `LanguageModelStreamChunk` (streaming deltas from the
model), `LiveChunk` (ephemeral in-flight step output). Kept.

**Ledger** (claim / settle + reconciliation):
The double-entry effect record: every world-changing effect gets a CLAIM entry
before the action and a SETTLE entry after. This is how the two-generals
problem is contained — not eliminated (impossible), but confined to exactly one
state: an open claim that has not settled. A deep sub-module depending on Log.
- **ClaimKey**: the stable identity of an effect, recomputed identically on
  replay (from callId, or `key(input)` for keyed effects). Same key ⇒ same
  effect, so replay can ask "already claimed?".
- **claim** → **ClaimDecision** (`acquired` | `duplicate-open` |
  `already-settled`): the atomic gate. `acquired` = you own it, perform then
  settle; `duplicate-open` = in flight, do NOT perform; `already-settled` =
  here is the recorded result, do NOT perform. Atomicity guarantees exactly
  one concurrent claimer gets `acquired`.
- **settle** → writes the terminal `SettleOutcome` (`ok` | `error` | `aborted`
  | `expired`). `expired` = a reconciler gave up within policy; terminal and
  distinct from `error`.
- **openClaims**: the unsettled-claims worklist — an ANTI-JOIN (claimed entries
  with no matching settle), NOT expressible as a `Query` (which filters ONE
  entry kind, not a relationship between two). So it lives on the LEDGER, not
  LogView: the Ledger owns claim/settle semantics, so the specialized
  claim-vs-settle index belongs where its meaning lives. LogView stays purely
  "read entries by indexable dimensions."
- Reconciliation is the Ledger's LIVENESS half (not a peer module — a
  reconciler only ever acts on open Ledger claims). It guarantees no claim
  stays open forever — the fix for the "eternal spinner."
_Avoid_: naming the ledger part of "Transcript"; action-log.

**Reconciler**:
The named, pluggable handler the Ledger drives to resolve a stale open claim
to a terminal outcome (uncertain → certain). Registered under a STABLE name
that is persisted with the claim and must survive deploys (the name is the
durable contract; the code is re-registered each wake). Carries a RetryPolicy.
- **ReconcileOutcome** (`retry` | `settle` | `wait`): `retry` = effect didn't
  happen, do it again; `settle` = I determined the outcome, close it; `wait` =
  someone else's correlated signal will settle it, check later.
- Unifies the async patterns: a `pending` tool / subagent / workflow / HITL
  approval is just an open claim awaiting a correlated settle, with the
  reconciler as backstop. Hence "not subsystems."
_Avoid_: ReconcilerSpec ("Spec" is filler); ReconcileContext (→ ReconcileDeps).

**ReconcileDeps**:
The bag a reconciler's `handle()` receives (the open `claim` entry, `attempt`
count, `policy`, and a `LogView`). `Deps`, not `Context`.
_Avoid_: ReconcileContext.

**Step / StepHandle / DurableConsumer / Blobs** (other Engine sub-modules):
- **StepHandle** (`write`/`commit`/`abandon`): the in-flight step — our commit
  unit. `write` streams ephemeral LiveChunks; `commit` atomically folds
  entries + run-marker into the Log; `abandon` discards chunks (committed
  claims survive — the point of claims). Harness-specific: a foreign harness
  need not use it.
- **DurableConsumer** (`pull`/`ack`): the at-least-once delivery cursor — the
  outbox engine, generalizing every outbox (workflow notices, channel
  delivery, client replay).
- **Blobs** (`putBlob`/`getBlob`): content store the Log references by BlobRef,
  so bulk (media, big outputs) never enters the Log inline.

### The composition root

**AgentDefinition**:
The complete declarative description of an agent, as a VALUE (not a base class
to extend). A preset (e.g. `think`) is an exported AgentDefinition users copy
and edit; swapping the loop, assembler, or a channel is changing a field. The
substrate beneath (DO hosting, alarm/clock, boot, connections, RPC —
deliberately excluded from this contract) receives the value and drives it.
_Avoid_: Agent (reserve for the RUNNING hosted thing / the DO instance —
mirrors the Log/Engine data-vs-service split: AgentDefinition is the value you
hand the runtime, Agent is what runs), AgentSpec, AgentConfig (undersells — it
is composed implementations, not config).

**Two tiers of an AgentDefinition** (the Harness re-partition):
- SUBSTRATE — true under ANY harness, governed by the runtime + Ledger:
  - `channels` (world → log → world) and `tools` (agent → world → agent) are
    PEERS: the two governed world-boundaries around the agent. Channels are
    how the world reaches in/out; tools are how the agent reaches out and gets
    async results back. Both use the same durability machinery (RetryContract
    on outboxes, claim/settle in the ToolRuntime, the Ledger, at-least-once).
  - `admission` (the gate, upstream of any harness) and `reconcilers`
    (Ledger-level durability backstop).
- HARNESS-INTERNAL — how a SPECIFIC harness thinks; moves INSIDE the harness:
  `model` (LanguageModel), `context` (ContextAssembler), `loop` (AgentLoop),
  `policy` (LoopPolicy), `failureNotice`. The default `stepHarness({ model,
  context, loop, policy, failureNotice })` takes exactly these; a foreign
  harness constructor takes whatever IT needs.
Mental model: channels and tools are the substrate's two world-boundaries; the
harness is the thinking in the middle. A foreign harness calling tools
out-of-band is an ungoverned side-effect — possible, but off the reservation,
not a first-class field.

**Deleted from AgentDefinition**: `compaction?` (compaction is one
ContextAssembler impl, not a top-level concern — a compacting agent just
supplies a `context` that compacts).

## Open questions (unresolved naming/design)

**Realtime / streaming story** — UNRESOLVED, revisit before implementation.
Two separable concerns live under "realtime":
1. Streaming the ordinary loop (model token deltas to a live client) — already
   first-class via the live-step buffer (`LiveChunk` / tail chunks /
   `StepHandle.write` in the engine). Not an afterthought.
2. Bidirectional live *media* (voice, screen share) where frames flow both
   ways and only semantic outcomes get logged — currently modelled as
   `RealtimeSession`, an escape hatch that bypasses the log. Christopher is
   unsure this should be an escape hatch at all; streaming/realtime is meant to
   be important, and "escape hatch" risks making it second-class. Its shape
   (and whether it is really an ExternalResource) is deferred, not settled.

**Foreign-loop / bring-your-own-harness escape hatch** — UNRESOLVED, revisit
before implementation. Motivation (Cloudflare Agents team view): there will not
be one agent harness. Developers are opinionated and will want to bring their
favorite — Pi (being rebuilt to run well on Workers), opencode, the AI SDK
loop, a Claude/Anthropic or Codex loop — and swap it in here. The SDK's value
to those users is NOT "we run your loop" but "we host you on Workers and give
you the transcript/channels/admission substrate around you, then get out of the
way."

This relocates the seam. It is not a `LanguageModel` variant (a foreign harness
executes its own tools and manages its own steps); it is closer to a LOOP
substitution:
- Native loop: implement `AgentLoop.step()`; the engine owns the commit
  boundary, claims/settles every effect, durability is ours (full residues).
- Foreign loop (harness adapter): hand us an opaque harness that runs to
  quiescence itself; the engine treats the whole episode as one span, commits
  only what the harness surfaces as entries, and durability INSIDE the span is
  the harness's job. The harness is a durability PEER, not a durability client.

Key principle: because the third party assumes durability for its span, it is
fine for the engine not to. The earlier "write tools escape claim/settle"
hazard stops being a bug and becomes the explicit contract — inside a foreign
loop, effect durability is delegated by design, eyes open.

RESOLVED. The seam is **Harness** (see the Loop section) — concrete type now
designed: `drive(deps: TurnDeps): Promise<void>`, one unified interface, called
fresh per wake (A1), leaving the log quiescent via a `turn/marker`. `TurnDeps`
is a narrowed surface (`turn`/`view`/`commit`/`write`/`tools`/`signal`);
`Ledger`/`Blobs`/`StepHandle`/full-Engine deliberately excluded. Tools are
always the governed `ToolRuntime`; BYO tools are additive and ungoverned.
Commit granularity (not injected surface) is the default-vs-foreign
distinction. `stepHarness({ loop, model, context, policy })` is the default
constructor; `StepDeps = TurnDeps ⊕ {model,context,loop}`. Composition
re-partition (substrate vs harness-internal) unchanged. See ADR 0002.
RETIRED (was never a desired thing — a pre-Harness loose thread, not a
proposal): the "composite / provider-loop LanguageModel" flag is closed. Once
`Harness` exists there is ONE LLM seam — the atomic `LanguageModel.generate`.
A provider that internally does multiple inferences / calls server-side
read-only tools is simply an ADAPTER IMPLEMENTATION of `generate()` (one
request in, one output out; how many internal HTTP calls happened is invisible
to the contract) — not a distinct type. Your-own iteration is an `AgentLoop`;
an opaque foreign loop is a foreign `Harness`; a provider's own internal loop
is a Shape-A adapter. No fourth thing. See the safety boundary on
`LanguageModel`.

**Transcript read-slice & self-resume** — RESOLVED by the LogView design
(`latest(kind,1)` finds the resume point, `since(seq)` reads the slice, both
index-served). Original note kept below for context.

Must resolve when the
transcript read surface is designed. Removing engine compaction-awareness is
only safe if a reader can (a) express the SLICE it cares about and (b) cheaply
locate its own resume point (e.g. its latest summary-overlay entry) so a
heavily-compacted conversation does not force O(full log) reads on every
assembly. The engine-served overlay used to give this for free. Primitives
that partly exist: `ReadOptions.after`/`until`/`limit`/`filter`,
`TranscriptView.head()`/`read()`. The missing piece is efficient "find my
latest entry of kind X" (indexed read by kind / latest-of-kind query / stored
cursor — TBD). Note: we do not yet fully understand how anything reads the
transcript; that design owes this requirement.

**LogView query surface** — RESOLVED (see the LogView / Query / LogExport
entries and ADR 0003). `query(q: Query)` over a closed struct of indexable
dimensions, newest-first-always, bounded-always (at-least-one of
`{after,before,limit}`), array (not stream) results, constructor functions
(`since`/`between`/`latest`/`window`) as the ergonomic surface, `openClaims`
moved to Ledger, `LogExport.scan` as the separate oldest-first full-traversal
escape hatch. Satisfies read-slice + self-resume (`latest(kind,1)`).

**Blobs lifecycle** — RESOLVED: it is NOT a lifecycle, it is a store.
- NO GC / refcounting. A blob's lifetime = the LOG's lifetime; deleting a
  branch/log deletes its blobs. Per-blob collection against an append-only,
  forkable, replayable log is a distributed-refcounting problem with replay
  hazards, for marginal benefit — not worth it. The reason it does not matter:
  blob SIZE was never the problem (storage is cheap); blob PRESENCE IN CONTEXT
  was, and that is already handled by the `BlobRef` indirection (the assembler
  chooses whether to resolve a ref into the prompt). GC would solve a
  non-problem while the real problem is handled elsewhere.
- NO quota type in the contract. Any size limit is a log-level or platform
  (R2/DO) policy, not something the blob store models.
- Streaming (`putBlob(ReadableStream | Uint8Array)`, `getBlob() =>
  ReadableStream`) is about MEMORY-BOUNDEDNESS, not lifecycle: a large blob is
  streamed to/from R2 so it never fully materializes in Workers memory. Keep
  the `ReadableStream` shape — it is the correct primitive.
- Surface placement (settled at Harness): `getBlob` on `LogView` (reading bulk
  is part of reading), `putBlob` paired with `commit` (writing bulk is part of
  writing an entry) — no separate `blobs` member on `TurnDeps`.

**Compaction reserved kind + `ReadOptions.compacted`** — to DELETE (decided at
`context.ts`, confirmed here). `CompactionPayload` (`compaction/summary`) leaves
the reserved core vocabulary and `ReadOptions.compacted` leaves the read API;
the Engine stops knowing compaction exists. UNBLOCKED: the LogView resolution
preserves the needed performance — a compacting assembler finds its latest
overlay with `latest("<mod>/summary-overlay", 1)` and reads the tail with
`since(overlaySeq)`, both index-served, so no O(full log) read. The
engine-served overlay is no longer needed.

## Review ledger

Files walked and approved together, file-by-file.

| File | Reviewed | Notes |
| --- | --- | --- |
| `src/resource.ts` | 2026-08-13 | `Resource` → `ExternalResource`; health states kept. |
| `src/channel.ts` | 2026-08-13 | `ChannelAdapter`→`Channel`, `InboundGateway`→`Inbox`, `OutboundSpec`→`Outbox`; `DeliveryContract` collapsed to `at-least-once`/`at-most-once`. `RealtimeSession` deferred (see open questions). |
| `src/admission.ts` | 2026-08-13 | `Admission`/`AdmissionPolicy` kept; decision `continue`→`resume`; other verbs kept. "Run" concept introduced informally (formalized with kernel/transcript). |
| `src/model.ts` | 2026-08-13 | `ModelPort`→`LanguageModel` (+ `Model*`→`LanguageModel*` prefix); `ModelStepOutput`→`LanguageModelOutput`; `classifyError`/`ErrorKind` kept. Composite/provider-loop "escape hatch" — later RETIRED (never a desired thing; Harness supersedes it). Kept only the adapter internal-loop safety boundary: `generate()` may loop internally but must perform no mutating effects. |
| `src/context.ts` | 2026-08-13 | `ContextAssembler`/"context"/`assemble` KEPT (context = what the model sees). Compaction trio REMOVED from contract (it is one assembler impl using private entries). `...Context` bags flagged for rename. `transcript.ts` review must reconsider `CompactionPayload` + `ReadOptions.compacted` and add read-slice/self-resume. |
| `src/tools.ts` | 2026-08-13 | `ToolProvider`/`ToolMiddleware`/`ToolRuntime` kept; capability ruled out-of-domain. `EffectDeclaration.clazz`→`effect: readonly\|mutating`; idempotency collapsed into shared `RetryContract` (`at-least-once`\|`at-most-once`) used by BOTH tools and channels. `GatedToolResult`→`ToolOutcome` (3 members; success/error both `settled`; `attempt` count not `replayed`). `ToolExecutionResult` (provider) kept. `ToolExecutionContext`→`ToolExecutionDeps`. |
| `src/loop.ts` | 2026-08-13 | Introduced **`Harness`** as the run-driving seam (ships default, BYO peer; owns durability); `AgentLoop`/`step` kept but demoted to the default harness's step-strategy. `StepOutcome.done`→`completed`; `parked` documented; `continue` kept (collision resolved via admission `resume`). `StepContext`→`StepDeps`. `LoopPolicy`/`RunFailureNotice` kept. Reshapes `AgentDefinition.loop` — confirm at `agent.ts`. |
| `src/transcript.ts` | 2026-08-13 | Split `Transcript` into **`Log`** (data) + **`Engine`** (service) + **`LogView`** (read view). Engine decomposed into deep sub-modules — see ADR 0001. Taught claim/settle + reconciliation; named the **`Ledger`** (claim/settle + its liveness half) and **`Reconciler`** (`ReconcilerSpec`→`Reconciler`, `ReconcileContext`→`ReconcileDeps`). `Entry`/`Part`/`DurableConsumer`/`StepHandle`/blobs kept. `CompactionPayload` + `ReadOptions.compacted` marked for deletion. LogView query surface deferred. |
| `src/loop.ts` (design) | 2026-08-13 | **Harness type designed** — see ADR 0002. `drive(deps: TurnDeps): Promise<void>`, unified interface, fresh per wake (A1), leaves log quiescent via marker. `TurnDeps` = `turn`/`view`/`commit`/`write`/`tools`/`signal` (narrowed; `Ledger`/`Blobs`/`StepHandle`/Engine excluded). `Step`/`StepHandle`→default-harness-internal; `StepDeps = TurnDeps ⊕ {model,context,loop}`. `Quiescence` return type dropped (void). |
| `src/transcript.ts` (design) | 2026-08-13 | **LogView query surface designed** — see ADR 0003. One `query(q: Query)` primitive over a closed indexable struct (`kinds`/`correlation`/`turn`/`after`/`before`/`limit`), newest-first-always, bounded-always (≥1 of `{after,before,limit}`), array results, constructors (`since`/`between`/`latest`/`window`). `openClaims`→`Ledger`. `LogExport.scan` oldest-first escape hatch. Unblocks compaction-awareness deletion. |
| `src/kernel.ts` | 2026-08-13 | **`Run`→`Turn`** everywhere (schemas-are-forever rename, full blast radius listed under Turn). Formalized `Turn`/`Step`/`quiescence` (quiescence sharpened: terminal vs suspended; distinct from effect-level `settled`). `Versioned`/tolerant-reader rule and `RetryPolicy` documented. `Brand`/`Json`/`JSONSchema`/`Seq`/`Backoff`/`TokenBudget`/`EntryRef`/id-brands kept (foundational). |
| `src/agent.ts` | 2026-08-13 | `AgentDefinition` kept (`Agent` reserved for the running thing). Field renames: `ChannelAdapter`→`Channel`, `ModelPort`→`LanguageModel`, `RunFailureNotice`→`TurnFailureNotice`, `ReconcilerSpec`→`Reconciler`. `compaction?` DELETED. Two-tier re-partition: substrate (`channels`, `tools`, `admission`, `reconcilers`) vs harness-internal (`model`/`context`/`loop`/`policy`/`failureNotice` move inside `stepHarness({...})`). `channels` and `tools` are peer world-boundaries. |
