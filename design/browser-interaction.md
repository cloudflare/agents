# Browser Interaction Layer

**Status:** internal experiment (`packages/agents/src/browser/interaction/`, `session-core.ts`, `capability.ts` — not exported)

## Problem

Harness evaluations of the codemode browser surface ([browser-tools.md](./browser-tools.md)) showed the model spending most of its budget on ceremony: `Target.getTargets` / `attachToTarget` boilerplate in the majority of executions, hard-coded sleeps standing in for a settle contract, and failures from raw CDP session ids going stale across executions. We want a typed interaction surface — snapshots, element refs, verbs — that can compete with raw CDP in evaluations, without betting the SDK on an unproven theory and without disturbing the shipping `browser_execute` surface. Raw CDP stays first-class: hosts will be able to expose verbs, CDP, or both, and evaluations decide the defaults (possibly per model tier).

## How it works

Three internal layers, added additively. None of it is exported from `agents/browser`; `browser_execute`, quick actions, and the connector keep shipping unchanged.

The two halves carry different release gates. The interaction contract (verbs, refs, snapshots) ships publicly **only if** side-by-side evaluations prove an agent gets better results with the typed verbs than with the raw CDP interface alone — if it does not, the contract is deleted and raw CDP remains the model surface. The named session core and the lifecycle capability address session loss, sweeping, and observability independent of that outcome, and are expected to ship with the starter pack either way.

### Interaction contract (`browser/interaction/`)

A provider-agnostic, plain-data contract:

- **Snapshots** — `BrowserSnapshot` pairs structured accessibility nodes with a compact text projection. Element refs are opaque, deliberately short-lived strings: navigation always invalidates them, and a provider may invalidate them on re-snapshot (validity beyond the minting snapshot is provider quality-of-implementation, never contract). The one guarantee: a stale ref fails with `STALE_REF` teaching text — it never silently resolves to a different element.
- **Targets** — an exclusive union: `{ ref }` | `{ selector }` | `{ x, y }`.
- **Verbs** — a fixed v1 set (21 verbs) with model-readable descriptions. State-changing verbs return a fixed-size `ActionEnvelope`; `waitFor` requires at least one condition (`text` and/or `textGone`; both means both must hold) and reports `settled: false` with the unmet condition instead of throwing, and settling never throws.
- **Errors** — a closed `InteractionErrorCode` set (`STALE_REF`, `TARGET_NOT_FOUND`, `NOT_INTERACTIVE`, `DIALOG_BLOCKED`, `SESSION_RESTARTED`, `NAVIGATION_TIMEOUT`), each with fix-oriented teaching text. `BrowserInteractionError` serializes to a wire shape and is recognized structurally so it survives the sandbox boundary.
- **Provider seam** — `InteractionVerbs<Outcome>` is shared by the model-facing `BrowserVerbs` and the host-side `InteractionProvider`. The seam is **verb-level**: each provider (raw CDP; `@cloudflare/playwright`) owns complete action execution, actionability checks, settling, and ref minting. Shared code owns result shapes, errors, and sessions. Session-level envelope fields (`sessionRestarted`, `humanHandoffResolved`) are added above the provider.

### Named session core (`browser/session-core.ts`)

`NamedBrowserSessions` gives hosts named, reattach-or-create Browser Run sessions:

- Names are the identity; the model never sees platform session ids. Records live under a `browser:session:<name>` keyspace, distinct from the connector's `cdp:exec:` / `cdp:reuse:` entries.
- `resolve(name)` reattaches to a live session or creates a replacement, reporting `restarted: true` when the previous browser died, was closed, or was swept — first-ever use reports `false`.
- Creation options (`keepAliveMs`, `recording`, `guardrails`) are durable: reapplied to every replacement session. `keep_alive` defaults to the 600-second platform maximum.
- `close` tombstones then deletes (best-effort — the tombstone is the durable outcome; the pinned `keep_alive` reclaims any browser whose delete failed); `sweep` tombstones idle live sessions and prunes aged tombstones. CDP commands on sockets from `connect` refresh the idle clock (throttled to 60s, capped at half the sweep window), so sweeps never reap a browser in active use. Dead sessions are tombstoned — never deleted — during recovery, so concurrent resolvers also see `restarted: true`. Store locks are held around storage reads/writes only — never across Browser Run network calls.
- `openOneShotBrowserSession` covers store-less create-and-close use, including Kitesurf (which is connection-scoped, so it is one-shot only and rejects guardrails).

### `BrowserSessions` lifecycle capability (`browser/capability.ts`)

A `LifecycleCapability` (id `"browser"`) composable onto an `Agent` subclass or a plain Durable Object via `Lifecycle`:

- Auto-supplies a `DurableBrowserSessionStore` over the Durable Object's storage; hosts may pass their own store.
- Schedules idle sweeps through a singleflight recurring Lifecycle job: armed on session activity, re-armed on start when entries survive a crash, rescheduled while entries remain, and completed when the store empties — an unused host carries no recurring alarm. The job id is namespaced (`browser-sessions:sweep`) so it can never contest a host's own job ids, session ops supersede a concurrently retiring dispatch rather than trusting its stale outcome, and a terminally failing sweep reschedules one idle window out instead of retiring.
- Host-only observability: `sessions()` lists named sessions with live/closed status and timestamps; `liveView(name, { mode })` mints fresh Live View URLs (valid ~5 minutes, never persisted) for a live named session and returns `undefined` for absent, tombstoned, or dead ones. The Live View vocabulary was extracted to `browser/live-view.ts` and shared with the connector.

When `BrowserSessions` is exported (planned once the API has been proven in use and evaluated), this is the example destined for `docs/agents/lifecycle.md` § Reusable capabilities, in that page's install style:

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { BrowserSessions } from "agents/browser"; // once exported

export class ResearchObject extends DurableObject<Env> {
  readonly browser = new BrowserSessions({
    browser: this.env.BROWSER,
    create: { guardrails: { allowedDomains: ["docs.example.com"] } }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.browser);

  async onRequest(_request: Request): Promise<Response> {
    // First call launches the browser; later calls reattach to it.
    const { cdp, restarted } = await this.browser.connect("research");
    if (restarted) {
      // Fresh browser — prior page state is gone; re-navigate before use.
    }
    try {
      await cdp.send("Page.navigate", { url: "https://docs.example.com" });
    } finally {
      cdp.close(); // detaches the socket; the named browser stays alive
    }
    return new Response("done");
  }
}
```

On an `Agent` subclass the only difference is installation — the Agent already owns a lifecycle, so the constructor runs `this.lifecycle.use(this.browser)` instead of `Lifecycle.install(this)`. The store, sweep scheduling, and crash recovery need no wiring in either style.

## Key decisions

- **Raw CDP remains a first-class agent surface**, composable with the verbs — not a fallback. The verb/ref/snapshot theory is unproven; it earns a public release through evaluations or it is removed.
- **Verb-level provider seam.** Providers may differ in actionability semantics; each lane documents and tests its own contract, and one shared conformance suite runs against both, rather than enforcing Playwright parity on the CDP lane.
- **Session identity is host-named, not model-promoted.** The connector's `dynamic` mode let the model promote a session; here the host wires a name and the core owns attachment. Recreation is loud (`restarted`), never silent.
- **The connector is untouched.** Its `reuse`/`dynamic` modes overlap the session core for now; the overlap is bounded and resolves when the model surface moves onto the core.

## Tradeoffs

- Temporary duplication between connector session modes and the named session core.
- A fully pruned tombstone makes a later `resolve` look like first use; the retention window covers realistic resumes.
- Verb-level seams permit behavioral drift between the CDP and Playwright lanes; the conformance suite contains it but does not eliminate it.

## Relationship to browser-tools.md

[browser-tools.md](./browser-tools.md) describes the shipping codemode connector surface (`browser_execute`, quick actions, Live View, recording). This document describes the internal layer being built alongside it. The two share `browser-run.ts`, the session stores, and `live-view.ts`.
