# Browser Interaction Contract

**Status:** parked — lives only on the `park/browser-interaction-contract` branch. It was merged in #2291 and reverted from `main`; it returns only if a general evaluation solution shows typed verbs beat raw CDP.

## Problem

Harness evaluations of the codemode browser surface ([browser-tools.md](./browser-tools.md)) showed models spending much of their budget on ceremony and foot-guns in raw CDP: a huge API surface, hard-coded sleeps standing in for a settle contract, and verbose accessibility handling. Tools such as agent-browser and Playwright MCP instead give the model a small verb vocabulary over accessibility snapshots. This contract is the typed, provider-agnostic shape for that surface, built so it can be compared against raw CDP in evaluations before anything ships.

## How it works

`packages/agents/src/browser/interaction/` is a plain-data contract with no implementation behind it yet:

- **Snapshots** — `BrowserSnapshot` pairs structured accessibility nodes with a compact text projection. Element refs are opaque, deliberately short-lived strings: navigation always invalidates them, and a provider may invalidate them on re-snapshot (validity beyond the minting snapshot is provider quality-of-implementation, never contract). The one guarantee: a stale ref fails with `STALE_REF` teaching text — it never silently resolves to a different element.
- **Targets** — an exclusive union: `{ ref }` | `{ selector }` | `{ x, y }`.
- **Verbs** — a fixed v1 set (21 verbs) with model-readable descriptions (`VERB_DESCRIPTIONS`). State-changing verbs return a fixed-size `ActionEnvelope`; `waitFor` requires at least one condition (`text` and/or `textGone`; both means both must hold) and reports `settled: false` with the unmet condition instead of throwing, and settling never throws.
- **Errors** — a closed `InteractionErrorCode` set (`STALE_REF`, `TARGET_NOT_FOUND`, `NOT_INTERACTIVE`, `DIALOG_BLOCKED`, `SESSION_RESTARTED`, `NAVIGATION_TIMEOUT`), each with fix-oriented teaching text. `BrowserInteractionError` serializes to a wire shape and is recognized structurally so it survives the sandbox boundary.
- **Provider seam** — `InteractionVerbs<Outcome>` is shared by the model-facing `BrowserVerbs` and the host-side `InteractionProvider`. The seam is verb-level: each provider (raw CDP; `@cloudflare/playwright`) owns complete action execution, actionability checks, settling, and ref minting. Shared code owns result shapes, errors, and sessions. Session-level envelope fields (`sessionRestarted`, `humanHandoffResolved`) are added above the provider.

## Key decisions

- **Evaluation-gated.** The verb/ref/snapshot theory is unproven. It ships only if side-by-side evaluations (raw CDP vs verbs vs both, across quality, token cost, latency, and failures) show it helps; otherwise it is deleted and raw CDP stays the model surface.
- **Raw CDP stays first-class**, composable with the verbs — not a fallback. Hosts could expose verbs, CDP, or both, with evaluations choosing defaults (possibly per model tier).
- **Verb-level provider seam.** Providers may differ in actionability semantics; each lane documents and tests its own contract, and one shared conformance suite runs against both, rather than enforcing Playwright parity on the CDP lane.
- **Harness-agnostic core.** Harness adapters (AI SDK, TanStack AI, MCP, codemode) would project the same verbs and descriptions, rather than each defining its own.

## Tradeoffs

- Verb-level seams permit behavioral drift between the CDP and Playwright lanes; the conformance suite contains it but does not eliminate it.
- A second model surface to document and teach alongside raw CDP, justified only if evaluations show a measurable win.

## Resuming

Rebase this branch onto `main`; it should apply cleanly because nothing on `main` imports `browser/interaction/`. Build the raw-CDP provider in conformance slices, then run the evaluation comparison before exporting anything.
