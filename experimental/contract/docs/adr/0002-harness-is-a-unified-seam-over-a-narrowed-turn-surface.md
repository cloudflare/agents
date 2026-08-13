# Harness is a unified seam over a narrowed per-turn surface

Status: proposed

## Context

The generated contract drove a turn with a runtime-owned `driver` that consumed
`AgentLoop.step()` plus a `LoopPolicy`, with `model`/`context` sitting at the
top level of `AgentDefinition`. During the domain-modeling pass we established
(CONTEXT.md, ADR 0001) that the run-driving loop is itself THE seam — the
**Harness** — because there will not be one agent harness: developers will
bring Pi, opencode, the AI SDK loop, a Claude/Codex loop. A foreign harness is
a peer, not an escape hatch. That left the concrete `Harness` type, its
injected surface, and how the default and foreign harnesses relate as open
design questions. This ADR settles them.

## Decision

**One unified interface, driven fresh per wake, leaving the log quiescent:**

```ts
interface Harness {
  drive(deps: TurnDeps): Promise<void>;
}
```

- **Unified (not two types, no branch).** The default step-harness and a
  foreign harness satisfy the SAME interface. The distinction between them is
  BEHAVIORAL — commit *granularity* — not STRUCTURAL. There is no
  `if (foreign)` path and no different injected surface. This supersedes ADR
  0001's phrasing that the seam is "which sub-modules you receive."

- **Fresh per wake (A1).** A parked turn holds NO in-memory state; every wake
  is a new `drive()`. The harness rehydrates from `deps.view`. It is not told
  *why* it woke — the log is the snapshot. The harness reads the tail (latest
  `turn/marker`), `openClaims()` (what it was waiting on), and the newest
  correlated entry (the trigger). A harness needing an idiosyncratic wake
  signal writes its own private pass-through entry and reads it back — no new
  type. There is no `resume()` method: one `drive()` handles start and resume,
  distinguished by reading the view.

- **Returns `void`.** The harness's contract is to leave the log QUIESCENT: it
  commits a terminal (`completed`/`failed`) or suspended (`parked`)
  `turn/marker`, and the runtime learns the outcome by reading that marker off
  the tail like any other cold reader. No `Quiescence` return type — the log
  already carries the state, so returning it would be redundant with the marker
  the harness just committed. The failure REASON
  (`exhausted`/`aborted`/`fatal`) lives in the `failed` marker; the runtime
  renders the terminal banner from it (harness owns reason, runtime owns
  presentation).

**The injected surface is narrowed (`TurnDeps`), not the full Engine:**

```ts
interface TurnDeps {
  readonly turn: TurnInfo;                       // identity, not situation
  readonly view: LogView;                        // read tail/openClaims + getBlob
  commit(entries: readonly NewEntry[]): Promise<readonly EntryRef[]>; // + putBlob pairing
  write(chunk: Json): void;                       // live streaming
  readonly tools: ToolRuntime;                    // governed; BYO is additive/ungoverned
  readonly signal: AbortSignal;
}
```

- **`commit`/`write` are step-agnostic.** The shared surface exposes atomic
  append + live streaming at whatever granularity the harness chooses. `Step`
  and `StepHandle` are the DEFAULT harness's way of USING these primitives
  (open → write\* → commit-with-marker, single-open-step invariant), layered on
  top — not part of the seam. The default commits once per step (full
  residues); a foreign harness commits once per span or at its own checkpoints
  (durability peer; residues delegated to it).

- **`Ledger` is excluded.** Claim/settle is reachable ONLY through
  `ToolRuntime`. A harness's own (BYO) effects are the ungoverned ones by
  definition, so there is no in-boundary consumer of the ledger and a harness
  cannot half-use it.

- **`Blobs` is not a separate member.** `getBlob` rides on `LogView` (reading
  bulk is part of reading); `putBlob` pairs with `commit` (writing bulk is part
  of writing an entry). The blob LIFECYCLE (GC/retention/streaming) is a
  separate deferred thread.

- **Also excluded:** `fork`, `consumer` registration, `reconciler`
  registration, raw un-committed `append` — all runtime/substrate concerns.

**The default harness is a constructor over harness-internal fields:**

```ts
function stepHarness(config: {
  loop: AgentLoop; model: LanguageModel;
  context: ContextAssembler; policy: LoopPolicy;
}): Harness;
```

Its `drive()` is the while-loop: rehydrate → build `StepDeps` → `loop.step()` →
map `StepOutcome` → commit → repeat until not `continue` → commit terminal
marker. `StepDeps = TurnDeps ⊕ {model, context, loop}` — the step sees the turn
surface plus the default harness's brain. This superset relationship is the
bridge between the seam and the default loop; only the default harness has a
`StepDeps`.

## Considered options

- **`drive()` returns a `Quiescence` enum** (`completed|parked|failed`).
  Rejected: redundant with the `turn/marker` the harness commits anyway; the
  runtime reads the tail regardless. `void` is the honest consequence of
  "the log is the snapshot."
- **Two harness interfaces / a durability-mode discriminant / a generic
  `Harness<Surface>`** (B1/B2). Rejected in favour of one interface with
  behavioral granularity (B3): peers must share a type, and the granularity
  difference is expressible through a single shared `commit`.
- **Hand the whole `Engine` to the harness.** Rejected: violates "receive only
  the sub-modules you need" (ADR 0001); exposes `fork`/`consumer`/`reconciler`/
  raw `append` a harness has no business calling.
- **Pass the triggering entry into `drive()`.** Rejected: the trigger is the
  newest correlated entry on `view`; passing it duplicates the log.
- **Keep `StepHandle` in the shared surface.** Rejected: it is
  default-harness-shaped (bundles step lifecycle + marker stamping); a foreign
  harness would be forced to wear our step vocabulary. Shared surface is
  `commit`+`write`; `Step` is one harness's internal usage.

## Consequences

- `AgentDefinition` loses top-level `loop`/`policy`/`model`/`context`/
  `failureNotice`; they move inside `stepHarness({...})`. Substrate
  (`channels`, `tools`, `admission`, `reconcilers`) stays top-level. (Matches
  the two-tier re-partition in ADR 0001 / CONTEXT.md.)
- A foreign harness is genuinely a peer: handed the same `TurnDeps`, it commits
  at its own granularity and owns durability for its span, eyes open. The
  earlier "write tools escape claim/settle" hazard is now the explicit
  contract, not a bug.
- Corrects ADR 0001: the Engine-decomposition still holds, but the harness seam
  is granularity-of-commit over a shared surface, not sub-module selection.
- Opens a deferred **Blobs lifecycle** thread (GC/retention/streaming).
- The eventual `src/` rename/restructure folds `loop.ts` into a `harness.ts`
  that exports `Harness`/`TurnDeps`/`stepHarness`, with `AgentLoop`/`StepDeps`/
  `StepOutcome`/`LoopPolicy` as default-harness-internal.
