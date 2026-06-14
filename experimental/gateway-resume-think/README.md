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
re-attach to the *same* upstream run and replay the exact tail — zero new tokens.

## The pattern

```
getModel()  ── capture cf-aig-run-id (onRunId) + live SSE offset (onProgress)
            └─ this.stash({ runId, eventOffset })        # survives eviction

‹DO evicted mid-turn›

onChatRecovery(ctx)  ── planResume(ctx.recoveryData)     # checkpoint fresh?
                     └─ arm re-attach, return { continue: true }

continueLastTurn()   ── getModel() returns a re-attach model
                     └─ createResumableStream({ runId, fromEvent })  # byte-exact tail
```

Key files:

- `src/plan.ts` — pure Layer-B decision (`planResume`): re-attach vs. fall back.
- `src/resume.ts` — the resumable stream (vendored from `workers-ai-provider`),
  in re-attach mode (no `initial`, start from `fromEvent`).
- `src/gateway-model.ts` — builds the AI SDK model over `env.AI.run`, capturing
  the run-id/offset (`buildCaptureModel`) or re-attaching (`buildReattachModel`).
- `src/server.ts` — the `Think` subclass wiring it together.

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
interrupts mid-stream (`ctx.abort()`), then polls `/gw/debug` and asserts the
recovery `plan` was `reattach` and the transcript converged. Example run:

```
✓ captured run 47e67890a911… at event 86
→ interrupt (ctx.abort, mid-stream)
✓ re-attached to run 47e67890a911… from event 88
✓ turn converged — assistant message: 510 chars
```

> **What "converged" means here.** The AI Gateway run is **server-driven /
> detached**: generation continues to completion even after the originating
> request disconnects (verified in `experimental/gateway-resume` via `/detach` —
> a `resume?from=0` issued after a mid-stream `reader.cancel()` blocks while
> tailing the live run and replays the **complete** stream including the terminal
> event). So re-attach is genuinely **zero-loss**, not "whatever was buffered at
> the abort." The 510 chars above is the **tail** (events 88→end), parsed
> byte-exactly from `from=88` and concatenated with the prefix Layer A already
> delivered — together the full message, **zero new tokens**. (Re-attaching with
> `fromEvent: 0` instead would replay the whole message and replace the partial.)
> The point this validates is the Layer-B path: capture → stash → recovery
> decision → byte-exact re-attach → clean convergence, on a real DO eviction.

## Caveats

- This vendors a copy of the resume primitive so the experiment is
  self-contained; the shipping version lives in `workers-ai-provider`
  (`createResumableStream`, `workers-ai-provider/gateway-delegate`).
- The gateway resume buffer TTL is ~5.5 min; `planResume` falls back to
  regeneration beyond a conservative window.

Related: [`experimental/gateway-resume`](../gateway-resume) (the raw transport
harness) and [`experimental/chat-recovery-probe`](../chat-recovery-probe) (the
Layer-A/fiber recovery probe this is modeled on).
