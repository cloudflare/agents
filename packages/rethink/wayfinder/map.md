# Wayfinder map: rethink composition model

Label: `wayfinder:map`. Tickets are files under `tickets/`, numbered from `01`.
Frontier = open tickets that are unblocked and unclaimed; scan `tickets/` and
take the lowest-numbered one. Claim by setting `Status: claimed` before any work.

## Destination

A design spec for `rethink` that locks:

1. The composition model — plain-instance primitives with narrow interfaces,
   plus a registration flow that lets a primitive contribute Worker/DO-boundary
   behavior (routing, WebSocket handlers, `alarm`, queue, email dispatch) into
   the shared entrypoints.
2. A primitive catalog decomposing both `Agent` and `Think`, with boundaries drawn.

Plus a tracer-bullet implementation: a WebSocket channel and an Email channel
coexisting on one bare DO, proving the model handles multiplexed inbound/outbound
boundary dispatch with no blessed base class.

## Notes

- This effort carries execution into the map (overrides wayfinder's plan-only
  default) for the tracer-bullet ticket only. Every other ticket produces a
  decision, not a deliverable.
- Leaning: plain instances constructed over `ctx.storage`/`ctx`, narrow
  interfaces, minimal magic.
- "No blessed base class" is refined (ticket 01) to "no _god_ base class": a
  thin, dispatch-only `PrimitiveHost` base is allowed; the bright line is that
  no domain behavior/state ever lands on it.
- Two kinds of primitive are emerging: _edge-facing_ (channels — implement
  entrypoint methods, care about the Worker boundary) and _inner_ (consumed by
  other primitives via `deps`, no entrypoints, no external bindings). Expected
  to be mostly inner. Ticket 03 sense-checks the model against the inner case.
- Recovery (resume a partial LLM stream after DO eviction) is the effort's
  headline acceptance signal: it must eventually work standalone in a bare DO.
  Deferred to a depth-validation ticket in the fog.
- Existing god classes being decomposed: `Agent`
  (`../../agents/src/index.ts`, ~11k-line class body) and `Think`
  (`../../think/src/think.ts`, ~12.6k-line class body).
- Skills every session should consult: `grilling`, `domain-modeling`,
  `prototype`, `tdd`.

## Decisions so far

<!-- the index — one line per closed ticket: gist + link -->

- [Composition model & registration flow](tickets/01-composition-model-registration-flow.md)
  — two layers (Worker export + DO); author `extends PrimitiveHost` (thin,
  dispatch-only base) and supplies only `build(ctx, env)` returning the
  primitives array; primitives are plain `(ctx, deps)` objects exposing optional
  DO-shaped methods; Worker side is a GENERIC forwarder + app addressing (not a
  per-primitive Worker half) — the DO-side chain owns "which primitive".

- [Channels abstraction design](tickets/03-channels-abstraction-design.md)
  — ChannelIn/ChannelOut roles on Primitive (transport only); generic
  InboundMessage<TRaw, TReplyTo> + onMessage registration;
  ChannelOut<TTarget>.openStream writes UIMessageChunk and completes/interrupts;
  in-method claim for fetch/email; generic deliverEmail + claim; dedicated
  webhook channel classes; no required channel storage. WebSocket protocol
  compatibility deferred. Policy deferred.

- [WebSocket channel scope for the tracer bullet](tickets/05-websocket-channel-scope.md)
  — tracer WS channel implements a compatibility slice that is a precise subset
  of the existing Agent protocol (connect + `cf_agent_use_chat_request` in +
  `cf_agent_use_chat_response` out, body = a `UIMessageChunk`); tag-based
  in-method socket self-claim (`acceptWebSocket` with channelId tag,
  `getTags(ws)` filter), no host routing registry; serializable OutTarget
  `{ connectionId, requestId }` re-resolved via `getWebSockets`; outbound
  maps complete/interrupt/error onto existing frames via AI SDK chunk types
  (finish/abort/error), no new frame shapes; hibernation accept required.
  Resume/RPC/state/recovery/agent-tools deferred to the full lift.

- [Tracer bullet: WebSocket + Email channels on a bare DO](tickets/04-tracer-bullet-websocket-email-bare-do.md)
  — running Workers-runtime tracer proves the model: thin dispatch-only
  `PrimitiveHost`, independent WebSocket and Email channel primitives, in-method
  entrypoint claim, shared ChannelDirectory egress, and no need to reopen the
  composition model.

## Not yet specified

<!-- in-scope fog; graduates into tickets as the frontier advances -->

- Worker→DO stub addressing (which instance, by what name) for forwarding
  entrypoints. Per-primitive claim on the DO is decided (ticket 03); instance
  naming is still fog.
- Channel policy (instructions/tools/maxTurns keyed by channel) — deferred from
  ticket 03; may become a second interface later.
- Alarm/schedule storage: shared schedule table vs each primitive arming
  `ctx.storage.setAlarm` (only one alarm per DO), and how the broadcast
  `alarm()` fan-out reconciles with that single slot.
- Storage namespacing: how co-located primitives avoid SQL table / KV key /
  migration collisions.
- Chat-specific primitive boundaries: inference loop, turn lifecycle,
  actions/ledger, HITL, extensions, skills, submissions, context-overflow,
  auto-continuation, chat protocol.
- Recovery depth-validation: a primitive composed from fibers + streaming +
  storage + alarms, proving the model supports primitive-composes-primitives.
- Cross-primitive communication/observation: e.g. scheduling firing a callback
  that mutates state; agent-tools streaming out over a channel.
- Packaging & public export surface: one package with many exports vs many packages.
- Migration path from `Think`/`Agent` to rethink primitives.

## Out of scope

<!-- ruled beyond the destination; never graduates -->

- Full implementation of the catalog — a separate effort once the model is locked.
- Feature parity with `Think`.
- Lifting the full Agent WS protocol (resume, RPC, state sync, recovery,
  agent-tools) into the channel shape — a follow-on implementation effort after
  the tracer proves the compatibility slice ([ticket 05](tickets/05-websocket-channel-scope.md)).
