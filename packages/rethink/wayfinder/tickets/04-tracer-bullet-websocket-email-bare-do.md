# Tracer bullet: WebSocket + Email channels on a bare DO

Type: task (execution)
Status: closed
Blocked by: 01, 03, 05

## Question

Does the composition model actually work? Prove it with running code.

This is the map's one execution ticket. Build, in
`packages/rethink/src`, a WebSocket channel and an Email channel as independent
primitives, then compose both onto a single Durable Object that `extends
PrimitiveHost` (the thin, dispatch-only base from ticket 01 — a base class is
allowed as long as it carries no domain behavior) using the registration flow
from ticket 01, the Channels design from ticket 03, and the WebSocket scope from
ticket 05.

Success criteria:

- A DO extending the dispatch-only `PrimitiveHost` composes two channels that
  each register into different shared entrypoints (`fetch`/`webSocketMessage`
  and `email`), with no domain behavior on the base class.
- Inbound events route to the correct channel; outbound delivery works on both.
- The two channels coexist without colliding (storage, entrypoint dispatch).
- A test proves it runs in the Workers runtime (vitest + `@cloudflare/vitest-pool-workers`).

If the model can't express this cleanly, that's a signal to reopen ticket 01.

## Resolution

Implemented in `packages/rethink/src` and proved by
[`tracer-bullet.test.ts`](../../tests/cases/tracer-bullet.test.ts).

The model expresses the tracer cleanly, so ticket 01 does not need to reopen:

- `PrimitiveHost` is a thin, dispatch-only Durable Object base. It owns only
  entrypoint fan-out (`fetch`, WebSocket hibernation events, `alarm`, and
  `deliverEmail`) and has no channel/domain behavior.
- `WebSocketChannel` and `EmailChannel` are independent plain primitives
  constructed from `(ctx, deps)`. They claim different shared entrypoints in
  method: WebSocket claims `/ws` upgrades and self-filters hibernated frames by
  tags; Email claims forwarded messages by recipient.
- Both channels implement the ChannelIn/ChannelOut roles. The shared
  `ChannelDirectory` wires inbound handlers to explicit outbound targets without
  a central target union.
- The WebSocket tracer keeps the scoped Agent protocol subset:
  `cf_agent_use_chat_request` in, `cf_agent_use_chat_response` out, chunk bodies
  as JSON, and `done:true` terminal frames.
- The Workers-runtime test composes both channels on one bare DO, verifies
  WebSocket inbound/outbound delivery, verifies Email inbound/outbound delivery,
  and proves they do not collide on entrypoint dispatch.

No new fog graduated from this ticket. Existing fog around Worker→DO addressing,
storage namespacing, alarm scheduling, policy, recovery, and migration remains.
