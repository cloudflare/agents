# rebuild — minimal implementation of the composable-rebuild contracts

A real, minimal agent conforming to `experimental/contract`: the Engine over a
SQL seam, the runtime host, the default step harness + loop, and reference
implementations of every module contract. Types come from the contract package
via `import type` only (it contains `declare function` stubs with no runtime
body); every callable thing is implemented here.

## Build and test

No dependencies, not a workspace member (deliberately — a new workspace
package would break frozen-lockfile CI). Compiles with a pinned tsc via npx,
tests run under `node --test` against Node's built-in `node:sqlite`:

```bash
cd experimental/rebuild
npx -y -p typescript@5.9.3 tsc -p .
echo '{ "type": "commonjs" }' > dist/package.json   # root package.json is ESM
node --test dist/rebuild/tests/*.test.js
```

14 tests, all passing: engine unit tests (append idempotency, bounded query,
claim/settle, consumer redelivery, fork lineage, blobs), the happy-path e2e,
queueing, and the durability suite — crash mid-turn with zero duplicated
effects across two hosts, crash-after-answer with no regeneration, approval
park/resume across a host restart, pending-tool settle/resume.

## Layout

```
src/
  contract.ts        type-only re-export of ../contract/src
  substrate.ts       SqlDatabase + Clock seams (DO SqlStorage-compatible)
  ids.ts             id minting, brand casts, FNV digest
  engine/            createEngine: Log/Ledger/Steps/Consumers/Blobs/Export
    schema.ts        one function owns all tables (rb_*)
    query.ts         since/between/latest/window + boundedness invariant
    engine.ts        the Engine; lineage-aware queries; reconcile pass
  tools/runtime.ts   ToolRuntime: approval → claim → execute → settle; the
                     tools reconciler; approval + settlement entry kinds
  harness/
    step-harness.ts  stepHarness(): drive-to-quiescence, marker stamping
    default-loop.ts  defaultLoop(): assemble → generate → execute; view-first
                     at-least-once idempotency guard
  context/window-assembler.ts   windowed pure assembler
  admission/default.ts          start/queue/resume/ignore policy
  channels/local.ts             reference Channel (inbox + outbox + dedupe)
  models/mock.ts                deterministic scriptable LanguageModel
  models/workers-ai.ts          real adapter over the env.AI binding (untested
                                locally; structural AiBinding type)
  runtime/host.ts    startAgent(): wake scan, admission/outbox/reconciler
                     pumps, TurnDeps wiring, waitUntilQuiescent
tests/               node:test suites + the node:sqlite SqlDatabase adapter
```

The `SqlDatabase` seam is the DO portability line: `exec(query, ...bindings) →
rows` plus `transaction(fn)`. The test adapter wraps `node:sqlite`; a Durable
Object adapter wraps `ctx.storage.sql.exec` + `transactionSync` with the same
~30 lines. `startAgent()` is "the DO wakes": its wake scan re-drives
interrupted turns exactly as an alarm handler would, which is why killing one
host and starting another over the same database is a faithful crash test.

## What the durability tests demonstrate

- **The log is the snapshot.** There are no fiber snapshots and no recovery
  classification anywhere in this codebase. Crash recovery is: wake scan finds
  an active turn → drive() → harness reads markers → loop reads messages →
  continues. The `classifyResume` function in the default loop (40 lines) is
  the entire replacement for the previous recovery machinery.
- **The ledger confines the two-generals gap.** The mutating tool in the crash
  test executes exactly once across two host processes because re-execution
  hits `already-settled` and replays the recorded result.
- **Parked turns hold no memory.** Both park tests resume on a *different*
  host than the one that parked. Approval, pending effects, and
  auto-continuation are all the same mechanism: a correlated entry landing at
  admission.

## Contract findings (friction discovered while implementing)

> **Status:** findings 1, 2, 4, 5, 6 and 7 were resolved by contract ADR 0004
> (`openClaims` on TurnDeps; `Role` gains `tool`; `Steps`/`StepHandle`
> deleted; claims born correlated + `openClaimByCorrelation`; approval mode
> `policy` removed; retry-vs-wait clarified as budgetary). This implementation
> and its tests were updated in the same change. Findings 3 (TurnStatus lacks
> `queued`) and 8 (merge-is-free) remain open. The original findings are kept
> below as the record of what implementation surfaced.

1. **`TurnDeps.view` cannot reach `openClaims`.** CONTEXT.md says a harness
   rehydrates from "the tail, openClaims(), and the newest correlated entry",
   but ADR 0003 moved `openClaims` to the Ledger and ADR 0002 excludes the
   Ledger from `TurnDeps`. The default harness managed without it (markers +
   messages sufficed), but a foreign harness that parks on its own effects
   will want it. Either `openClaims` joins `LogView`, or the CONTEXT wording
   should drop it.
2. **The Part vocabulary has no way to carry tool results back to the model.**
   `Role` is `user | assistant | system`; providers want role `tool`. This
   implementation commits tool-results as `user`-role carrier messages and
   the LanguageModel adapters re-map — workable, but it is a convention living
   outside the contract. Either add a `tool` role or document the carrier
   convention as normative.
3. **`TurnStatus` lacks `queued`, but `AdmissionInput.queued` models queued
   turns.** The runtime maps queued rows to `parked` when constructing
   `TurnInfo`, which is a lie at the margins. Either add `queued` to
   `TurnStatus` or type `AdmissionInput.queued` as something thinner than
   `TurnInfo`.
4. **`Steps`/`StepHandle` went unused.** With `TurnDeps.commit` (step-agnostic
   atomic append) in the seam, the default harness stamps its own markers into
   commit batches and never needs `Engine.steps`. It is implemented for
   contract parity, but ADR 0002 footnote confirmed: `StepHandle` may not need
   to exist at all once `commit` is the shared primitive.
5. **`ApprovalRequirement.mode: "policy"` needs a decider seam.** The contract
   names the mode but nothing supplies the policy. This implementation treats
   `policy` as `always` (conservative); the natural home is a ToolMiddleware,
   which suggests the mode belongs to the middleware layer, not the
   descriptor.
6. **Who settles a pending claim is underspecified.** The provider's "inbound
   half MUST later append an entry carrying this correlation" — but the claim
   is keyed by ClaimKey, not correlation, so the runtime keeps a
   correlation→claim index (`rb_claims.correlation`) and a settlement entry
   kind (`tools/settlement`). Both are inventions the contract should either
   bless or replace.
7. **`ReconcileOutcome.retry` vs `wait` semantics.** "Retry = do it again" —
   but the Ledger cannot execute effects, so in practice both re-invoke the
   handler later and the difference is only whether the attempt counts against
   the budget. Implemented that way; the contract wording should match.
8. **Merge is free under log-first admission.** A queued turn assembles its
   context from the log when it starts, so `merge` needed no implementation at
   all — the folded message is simply present. Worth recording as the intended
   semantics rather than an accident.

## Known deviations / not yet done

- The Workers AI model is real code against a structural `AiBinding`, but has
  not run against a live binding (no Workers runtime here). It uses the
  non-streaming `run()` and re-chunks output.
- No DO host adapter yet: the missing pieces are the ~30-line SqlStorage
  adapter, a Clock over DO alarms, and a fetch/WS channel. The engine and
  runtime are written to make that additive.
- Branch forking is implemented and tested at the engine level but unused by
  the runtime (single-branch operation; concurrent-write branching per the
  open question is future work).
- `preempt` aborts the active drive but its terminal marker is written by the
  aborted harness on its next signal check — a slow model call delays it.
