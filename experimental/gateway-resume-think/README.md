# gateway-resume-think

A [Think](../../packages/think) agent that **re-attaches to an AI Gateway run on
Durable Object eviction** instead of regenerating — the missing "Layer B"
(DO↔upstream-LLM) recovery described in
[`design/rfc-workers-ai-gateway-merge.md`](../../design/rfc-workers-ai-gateway-merge.md) §9.

## The problem

The Agents SDK already buffers stream chunks so a **client** that reconnects sees
the rest of a turn (Layer A). But when the **Durable Object itself is evicted**
mid-turn, the chat-recovery fiber survives and `onChatRecovery` defaults to
`continueLastTurn()` — a **fresh model call** that re-spends tokens and
regenerates from scratch.

AI Gateway's resumable streaming (`cf-aig-run-id` + `resume?from=N`) lets us
re-attach to the _same_ upstream run and replay it — **zero new tokens**.

Crucially, the run is **detached / server-driven**: it generates to completion
after the originating request disconnects (proven in
[`experimental/gateway-resume`](../gateway-resume) via `/detach`). So on recovery
we re-attach **from event 0**, which replays the _complete_ buffered run and
reconstructs the full message — verified byte-for-byte against the ground-truth
`resume?from=0` (see `/gw/verify` and the driver).

## The pattern

```
getModel()  ── capture cf-aig-run-id (onRunId) + live SSE offset (onProgress)
            └─ this.stash({ runId, eventOffset })        # survives eviction

‹DO evicted mid-turn›

onChatRecovery(ctx)  ── planResume(ctx.recoveryData)     # checkpoint fresh?
                     └─ arm re-attach (fromEvent: 0), return { continue: true }

continueLastTurn()   ── getModel() returns a re-attach model
                     └─ createResumableStream({ runId, fromEvent: 0 })  # full replay
                        → REPLACES the partial leaf with the complete run
```

Key files:

- `src/plan.ts` — pure Layer-B decision (`planResume`): re-attach vs. fall back.
- `src/resume.ts` — the resumable stream (vendored from `workers-ai-provider`),
  in re-attach mode (no `initial`, start from `fromEvent`).
- `src/gateway-model.ts` — builds the AI SDK model over `env.AI.run`, capturing
  the run-id/offset (`buildCaptureModel`), re-attaching (`buildReattachModel`),
  or parsing a run to text for the ground-truth check (`parseReattachText`).
- `src/server.ts` — the `Think` subclass wiring it together, plus `verify()`
  (compares the recovered message to the full run).

## Run the hermetic tests

The decision logic and re-attach stream are unit-tested without a gateway:

```bash
pnpm install
pnpm --filter @cloudflare/agents-gateway-resume-think test
```

## Run end-to-end (live gateway)

Needs a deployed Worker and an AI Gateway with unified billing (or BYOK) for the
model vendor. Set the gateway id + model in `wrangler.jsonc` `vars`, then:

```bash
pnpm exec wrangler types env.d.ts --include-runtime false   # regen bindings
pnpm --filter @cloudflare/agents-gateway-resume-think deploy
node scripts/driver.mjs https://<your-worker-url>
```

The driver starts a turn, waits until the run-id is **captured + stashed**,
interrupts mid-stream (`ctx.abort()`), waits for the continuation to settle, then
calls `/gw/verify` to compare the recovered message against the ground-truth
**full** run (`resume?from=0`). Example run:

```
✓ captured run 241659d8a990… at event 43
  pre-evict stash — capture.offset=301 attempts=38 ok=38 failed=0 lastOk=297
→ interrupt (ctx.abort, mid-stream)
✓ recovery decision: reattach (stashed offset 305; re-attaching from 0 = full replay)
✓ turn converged — assistant message: 1580 chars
→ verify against ground-truth resume(from=0)
  recovered 1580 / full 17303 chars — diverge@1580   ← recovery still streaming
  recovered 17303 / full 17303 chars — MATCH         ← settled
✓ ZERO-LOSS — recovered === full run 17303 chars, zero regenerated tokens
```

> **Zero-loss, proven.** Because the run is detached (it completes server-side
> after the disconnect), re-attaching from event 0 replays the **complete**
> buffered run. `continueLastTurn` **replaces** the partial leaf with that full
> replay, so the recovered assistant message ends up **byte-identical** to the
> full run (`recovered === full`, 0 regenerated tokens) — validated live by
> `/gw/verify`. The interim `diverge@1580` line is just the verify poll racing a
> still-streaming continuation; it converges to a clean match once the tail
> finishes.
>
> **Why `from=0`, not the stashed tail offset.** We _do_ capture and stash the
> live SSE offset (and the throttle is delta-based — offsets jump, so a `% N`
> check never lands). But a tail re-attach from that offset would, under
> `continueLastTurn`'s replace semantics + the Layer-A↔SSE offset-space mismatch
> (RFC §9.4), risk dropping the prefix. `from=0` sidesteps both: it needs only
> the run-id, replays zero-token, and is provably whole. The stashed offset is
> kept for observability and the documented (riskier) tail-merge option.

## Caveats

- This vendors a copy of the resume primitive so the experiment is
  self-contained; the shipping version lives in `workers-ai-provider`
  (`createResumableStream`, `workers-ai-provider/gateway-delegate`).
- The gateway resume buffer TTL is ~5.5 min; `planResume` falls back to
  regeneration beyond a conservative window.

Related: [`experimental/gateway-resume`](../gateway-resume) (the raw transport
harness) and [`experimental/chat-recovery-probe`](../chat-recovery-probe) (the
Layer-A/fiber recovery probe this is modeled on).
