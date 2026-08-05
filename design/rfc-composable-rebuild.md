# RFC — Composable rebuild of Think and the Agents SDK

Status: proposed

Related:

- [think-vs-aichat.md](./think-vs-aichat.md) — the two chat hosts as they stand today
- [chat-shared-layer.md](./chat-shared-layer.md) — the shared `agents/chat` toolkit that was meant to prevent the fork
- [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md) — the shared recovery engine, and why convergence stalled
- [test-coverage-matrix.md](./test-coverage-matrix.md) — the test layers this proposal turns into a conformance gate

---

## The problem

Three files carry the SDK:

| File                         | Lines  | Class                    |
| ---------------------------- | ------ | ------------------------ |
| `packages/think/src/think.ts` | 15,862 | `Think`                  |
| `packages/agents/src/index.ts` | 13,234 | `Agent`                  |
| `packages/ai-chat/src/index.ts` | 6,948 | `AIChatAgent`            |

That is ~36,000 lines in three classes. The stated symptoms — regressions from changes that looked local, coding agents unable to hold the relevant context, unclear lifecycles — are downstream of four specific structural facts.

### 1. `Think` and `AIChatAgent` are a fork, not two users of a shared layer

`agents/chat` exists precisely to be the shared layer, and it is genuinely good: `turn-queue.ts`, `resumable-stream.ts`, `recovery-engine.ts`, `message-reconciler.ts`, `stall-watchdog.ts`, and ~25 more focused modules. Both hosts import it. Both hosts then reimplement the orchestration on top of it, separately.

**81 method names are defined in both `Think` and `AIChatAgent`** — out of 151 methods on `AIChatAgent` total. That is not overlap at the edges; it is the majority of one class duplicated in the other. The duplicated set is exactly the hard part:

- the entire recovery chain — `_beginChatRecoveryIncident`, `_updateChatRecoveryIncident`, `_exhaustChatRecovery`, `_chatRecoveryRetry`, `_chatRecoveryContinue`, `_routeStallToBoundedRecovery`, `_parkRecoveryForPendingInteraction`, `_rescheduleRecoveryAfterStableTimeout`, `_handleRecoveryOom`, `_cf_sealMemoryLimitedRecovery`
- auto-continuation — `_scheduleAutoContinuation`, `_fireAutoContinuation`, `_rearmPendingAutoContinuationForBatch`, `_hasArmedContinuation`, `_hasIncompleteToolBatch`
- agent-tool child runs — `startAgentToolRun`, `cancelAgentToolRun`, `inspectAgentToolRun`, `tailAgentToolRun`, `getAgentToolChunks`, `_persistAgentToolMilestone`, `_readAgentToolMilestones`
- detached delivery, orphan-stream persistence, resume handshake, stability probes, tool-result application

Every durability bug is now fixed twice or fixed once and silently left broken in the other host. This is the single largest source of "we fixed that already" regressions.

### 2. The same durable-work primitive is implemented six times

Counting the tables each subsystem creates and the drain/sweep/recovery machinery attached to each:

| Subsystem            | Table(s)                                                       | Owner    |
| -------------------- | -------------------------------------------------------------- | -------- |
| Fibers               | `cf_agents_fibers`                                              | `Agent`  |
| Schedules            | `cf_agents_schedules`, `cf_agents_facet_runs`                   | `Agent`  |
| Agent-tool runs      | `cf_agent_tool_runs`, `cf_agent_tool_child_runs`, `..._milestones` | `Agent` + both hosts |
| Queues               | `cf_agents_queues`                                              | `Agent`  |
| Submissions          | `cf_think_submissions`                                          | `Think`  |
| Workflow notices     | `cf_think_workflow_notifications`                               | `Think`  |
| Action ledger        | `cf_think_action_ledger`                                        | `Think`  |
| Pending approvals    | `cf_think_action_pending_approvals`                             | `Think`  |
| Declared tasks       | `cf_think_scheduled_tasks`                                      | `Think`  |

Nine tables, and structurally they are the same object: *a row with a status, an idempotency key, a payload, a claim, a settle, a retention sweep, an alarm to make progress, and a crash-recovery path.* Each one has its own `_ensure*Table`, `_read*Row`, `_claim*Row`, `_settle*Row`, `_delete*Rows`, `_sweep*`, `_drain*`, `_recover*OnStart`, and `_schedule*Drain`. `Think` alone contains four complete copies of that pattern.

Worse, `Think` reimplements *scheduling itself*. `_reconcileDeclaredScheduledTasks` sits on top of `Agent.schedule()` with its own schedule grammar, its own timezone validation, and a hand-rolled DST-safe wall-clock search (`findZonedInstant` scans minute-by-minute across a window). That is a second scheduler inside a class that already inherits one.

### 3. Lifecycle is implicit, spread across four mechanisms

There is no single place that says what happens when an agent wakes. Boot order lives as eleven numbered comments inside `Think`'s constructor, which reassigns `this.onStart` to a closure wrapping the subclass's `onStart`. Alarm behaviour lives in `Agent.alarm()` → `_cf_runAlarmBody` → `_executeScheduleCallback`, with a memory-limit circuit breaker (`_cf_handleAlarmMemoryLimitReset`) that has to reach back into subclass-declared callback names via `_cf_recoveryAlarmCallbacks()` to know which rows to purge. Recovery entry is a fiber hook (`_handleInternalFiberRecovery`) that both hosts override differently. Protocol entry is a handler map installed in `_setupProtocolHandlers`.

A reader — human or agent — cannot answer "what runs, in what order, on a cold wake with a half-finished turn and a pending approval" without reading all three large files. The ordering constraints are real and load-bearing (declared tasks must reconcile before submissions drain; hydration must survive `SQLITE_NOMEM`; recovery budgets must be evaluated *before* `onStart` because a config set in `onStart` arrives too late), but they are encoded as comments and call order rather than as a structure.

### 4. Capability is inherited, so it cannot be subtracted

`class Think extends Agent` means every Think gets all of it: workflows, email, MCP server hosting, facets, browser, queues, submissions, actions, channels, extensions, declared tasks. A user who wants a voice agent with a workspace pays for the workflow tracking tables and the submission drain. There is no way to compose a smaller agent, and — the more expensive consequence — no way to swap one part for an experiment without editing a 15,000-line file that everything else depends on.

---

## The proposal

Rebuild as a layered set of packages with a single hard rule: **dependencies point down, never up or sideways within a layer.** Capability comes from composing modules, not from extending a base class. `Think` survives as a *preset* — a named composition — not as a superclass.

### L0 — Substrate

The Durable Object adapter. Nothing above this layer touches `ctx` or `DurableObjectState` directly.

| Module      | Responsibility                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `host`      | DO lifecycle, `blockConcurrencyWhile`, and an **explicit boot-phase registry** — ordered, named, individually failable |
| `store`     | SQL access, migrations, typed table helpers. One place that knows the schema                        |
| `clock`     | **Sole owner of `alarm()`.** A timer registry everything else registers against, plus the OOM circuit breaker |
| `transport` | Connections, WS/HTTP routing, broadcast, readonly and protocol gating                               |
| `rpc`       | Callable methods, serialization                                                                     |
| `telemetry` | Spans and events                                                                                    |

The boot-phase registry is the direct fix for problem 3. Today's eleven numbered comments become eleven registered phases with declared ordering and declared degradation behaviour — the `_runBestEffortOnStartStep` pattern `Think` already invented, promoted from an ad-hoc helper to the contract.

### L1 — Durability primitives

The crown jewels. **One implementation each**, and everything durable in the system is expressed in terms of them.

| Module     | Responsibility                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `ledger`   | Durable work rows: status machine, idempotency key, claim / settle / release, retention sweep. Replaces all nine tables above with one generic table plus typed payloads |
| `run`      | Durable execution over `ledger` — snapshot via `stash`, survive eviction, resume, attempt accounting. Today's `runFiber` |
| `queue`    | Ordered drain over a `ledger` with a concurrency policy. Today's submissions drain, notification drain, and turn queue are three instances |
| `stream`   | Resumable chunk log: persist, replay, resume handshake, orphan capture. Already close to right in `agents/chat/resumable-stream.ts` |
| `recovery` | The incident state machine — budgets, stall detection, seal, give-up, OOM backoff — generic over *what* is being recovered |

Splitting `run` from `recovery` is deliberate: `run` is the mechanism, `recovery` is the policy. Keeping them apart is what makes recovery policy something you can experiment with without touching execution.

### L2 — Agent composition

| Module      | Responsibility                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `state`     | Replicated state, validation hooks, change broadcast                                                |
| `scheduler` | Cron / interval / one-shot over `clock` + `ledger`. **Declared code-defined tasks become a thin reconciler on top**, not a parallel system |
| `children`  | Sub-agents and facets: spawn, path routing, connection bridging, lifecycle cascade                  |
| `handoff`   | Parent↔child runs as `ledger` + `stream`. Agent-tools, detached runs, and sub-agent RPC are three configurations of one thing |
| `workflows` | Cloudflare Workflows binding adapter                                                                |

`handoff` collapses the third-largest duplication in the codebase. `startAgentToolRun`/`tailAgentToolRun`/`inspectAgentToolRun`/detached delivery exist in `Agent`, in `Think`, and in `AIChatAgent` — because the parent-side ledger, the child-side mirror, and the stream forwarding were never named as one primitive.

### L3 — Conversation

| Module      | Responsibility                                                                     |
| ----------- | ------------------------------------------------------------------------------------ |
| `session`   | Transcript tree, compaction, context blocks, search — **already exists and is already right** |
| `hydration` | Byte-budgeted transcript read, media eviction (the `#1710` work)                      |
| `repair`    | Interrupted tool parts, sanitization, row-size limits                                 |
| `context`   | Assemble system + messages, truncation, context-overflow classification               |

### L4 — Loop

| Module    | Responsibility                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------- |
| `loop`    | The agentic driver as an explicit stepped state machine, not a 400-line method. Named lifecycle events |
| `toolset` | Merge local, MCP, client, skill, and codemode tools into one set with clear precedence               |
| `gate`    | Approval, idempotency, and HITL pause as a **tool decorator over `ledger`** — replaces the bespoke Actions subsystem |
| `model`   | Model resolution and binding                                                                        |

`gate` is the largest single simplification available. Actions today are ~2,000 lines in `think.ts` spanning two tables, an approval descriptor protocol, a durable-pause parking mechanism, transcript annotation, and two sweep loops. Nearly all of it is `ledger` plus a wrapper that can suspend a tool call and resume it from a stored input hash.

### L5 — Surfaces

`chat-protocol` · `channels` / `messengers` · `voice` · `mcp` · `codemode` · `workspace` / `shell` · `browser` · `skills`

Several of these are already the shape we want — `@cloudflare/shell`, `@cloudflare/codemode`, `agents/skills`, and the session module are the existing proof that this decomposition works. They are the model, not the exception.

### What a plugin owns

The unit that makes this tractable for a coding agent is the plugin directory. One module owns, in one place:

```
modules/submissions/
  schema.ts       # its ledger payload type + migration
  boot.ts         # its registered boot phase
  api.ts          # its public surface
  recovery.ts     # its recovery handler
  index.ts        # its registration
  tests/          # its conformance tests
```

Everything an agent needs to reason about a change to submissions is inside that directory, plus the `ledger` contract. That is the property `think.ts` cannot have at any file length.

---

## Carrying the durability forward

The durability behaviour is the asset — most of it is hard-won bug fixes, not design (`SQLITE_NOMEM` on hydration `#1710`, the alarm memory-limit loop `#1825`, recovery work budgets, stall routing, tool rollback). It exists as lore in comments and as *behaviour* in `packages/think/src/e2e-tests/`:

```
action-ledger-recovery   action-pause-recovery      chat-recovery
context-overflow-recovery  messenger-recovery       persist-false-preserves
reattach-budget          stall-recovery             submission-recovery
task-amplification       tool-rollback              workflow-recovery
```

**Those fourteen scenarios are the specification.** The recommendation is to lift them out of `packages/think` into a host-agnostic durability conformance suite that runs against any composition, and make passing it the acceptance gate for the new primitives. That converts "the nice stuff Think acquired over time" from institutional memory into an executable contract — and it lets the rebuild proceed incrementally with a green/red signal at every step, rather than as a big-bang rewrite.

## Sequencing

The layers are independently valuable, which means this does not need to be one project:

1. **`ledger` + `clock`.** Build them, then port one subsystem (workflow notifications — smallest, most isolated) onto them. Proves the primitive against a real consumer.
2. **Port the remaining eight tables.** Each port is a self-contained PR with the conformance suite as its gate. This alone removes most of `Think`'s bulk.
3. **`handoff`.** Collapses the triplicated agent-tool machinery.
4. **`recovery` + `run` separation**, with both hosts moved onto the single implementation. Kills the 81-method fork.
5. **`loop` + `gate`.** The new authoring surface.
6. **`Think` becomes a preset** over the composed modules.

Steps 1–4 are refactors of the existing packages and can ship without a new public surface. Only 5–6 are a new SDK.

---

## Alternatives considered

**Keep extending `agents/chat`.** This was the plan of record ([rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md)) and it produced real value — the ~30 modules in `agents/chat` are good code. It failed to stop the fork because it extracts *helpers* while leaving *orchestration* in the host classes, and orchestration is where the duplication lives. Continuing this path shrinks the hosts slowly but never removes the second copy.

**Split the three big files without changing the model.** Mechanically splitting `think.ts` into ten files of 1,500 lines each improves nothing: the coupling is via shared private state on one class instance, so every file would still need the whole class in context. File size is the symptom; the single mutable object is the cause.

**Make `Think` extend `AIChatAgent`.** Removes the fork at the cost of deepening the inheritance chain to three levels and making capability even less subtractable. Solves problem 1 and worsens problem 4.

## Tradeoffs

- **No compatibility with current surfaces.** Accepted as an explicit premise. Existing packages continue to ship while the new ones are built.
- **Composition costs some ergonomics.** `defineAgent({ modules: [...] })` is more typing than `extends Think`. Presets recover this for the common cases; the point is that the preset is now a *value* you can copy and edit, not a class you have to subclass around.
- **A generic `ledger` is less legible per-subsystem than a purpose-built table.** Nine bespoke schemas do read more directly in isolation. The trade is nine recovery paths for one — and recovery paths are where the bugs are.

## The decision

Open. This RFC exists to be argued with.
