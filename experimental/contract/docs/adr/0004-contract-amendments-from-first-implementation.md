# Contract amendments from the first implementation

Status: accepted

## Context

`experimental/rebuild` implemented the contracts end to end (engine over a
DO-compatible SQL seam, runtime host, default step harness/loop, tool runtime,
channels, models) with a 14-test suite covering the durability scenarios. The
implementation surfaced eight points of friction (recorded in
`experimental/rebuild/README.md`); these amendments resolve the five we
decided to change. The remaining findings (TurnStatus lacks `queued`,
merge-is-free semantics) stay open.

## Decisions

1. **`openClaims` joins `TurnDeps`.** ADR 0002 excluded the Ledger from the
   harness surface, but CONTEXT.md's rehydration story ("the tail,
   openClaims(), the newest correlated entry") depended on it. The default
   harness got by using the transcript as a proxy for open claims — but a
   foreign harness committing at span granularity has effects with no
   transcript trace and genuinely needs the worklist. Resolution: the Ledger's
   WRITE half (claim/settle) remains reachable only through ToolRuntime;
   `TurnDeps.openClaims()` grants the read.

2. **`Role` gains `"tool"`.** Tool-result parts had no first-class carrier;
   the implementation smuggled them in `user`-role messages and re-mapped in
   every LanguageModel adapter — a normative convention living outside the
   contract. `"tool"` is now a reserved carrier role for messages holding
   tool-result parts.

3. **`Steps`/`StepHandle` are deleted.** With `TurnDeps.commit` (atomic,
   step-agnostic append) in the seam, the default harness stamps its own
   `turn/marker` entries into commit batches and never touched
   `Engine.steps`. The single-open-step invariant belongs to the harness that
   wants it. "Step" survives as vocabulary (`StepId`, `turn/marker.step`), not
   as an engine service. The `step-abandoned` TailEvent goes with it.

4. **Claims are born correlated; the Ledger resolves settlements.**
   `ClaimRequest.correlation` records the correlation an out-of-band
   settlement will carry, and `Ledger.openClaimByCorrelation()` resolves an
   arriving settlement entry to its claim. Previously both halves were
   implementation inventions (a private index column plus an engine hook);
   the pending-tool pattern ("tool-out / entry-back") now closes through
   contract surface.

5. **`ApprovalRequirement.mode` is `always | never`.** The `"policy"` mode
   named a decision-maker the contract gave no seam for. Conditional approval
   composes as a ToolMiddleware rewriting descriptors — the layer where
   authority already composes — so the descriptor now declares only the
   unconditional truth.

Also clarified without behavioral change: `ReconcileOutcome`'s `retry` vs
`wait` both re-invoke the handler later (the Ledger cannot execute effects);
the difference is budgetary — `retry` counts against `maxAttempts`, `wait`
does not.

## Consequences

- A foreign harness can rehydrate from `view` + `openClaims()` alone, as the
  Harness design always claimed.
- LanguageModel adapters translate `tool`-role messages instead of inferring
  carrier conventions.
- The Engine's sub-modules are now Ledger, Consumers, Blobs, LogExport — each
  passing the deletion test ADR 0001 set.
- `experimental/rebuild` updated in the same change; the 14-test suite is the
  regression net for these amendments.
