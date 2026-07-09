# Channels abstraction design

Type: grilling+prototype
Status: closed
Blocked by: 01

## Question

What is a Channel, as a standalone primitive?

Channels is the effort's original motivation: a new abstraction for message
inputs/outputs so a bot author picks only the transports they need (WebSocket,
email, WhatsApp, ...) instead of inheriting `Think`'s WebSocket-heavy machinery
wholesale.

Settle:

- The inbound and outbound interface a channel exposes (how a message arrives,
  how a reply/notice is delivered).
- How a channel contributes its entrypoint wiring via the registration flow from
  ticket 01: email channel → `email()`; WebSocket channel → `fetch()` upgrade +
  `webSocketMessage`/`webSocketClose`; webhook channel → an HTTP route in `fetch()`.
- How multiplexing works: routing an inbound event to the right channel when
  several share one entrypoint.
- What (if any) storage a channel owns (e.g. delivery cursor, phone-number →
  session mapping).

Keep it minimal — this design is what the tracer bullet (ticket 04) implements.
Reference the existing `Think` channels/messengers code
(`../../think/src/channels`, `../../think/src/messengers`) but do not port it;
this is a clean-room design.

## Notes carried from ticket 01

- Channels are the _edge-facing_ primitives — they implement the DO-shaped
  entrypoint methods and care about the Worker boundary. But most _other_
  primitives likely won't touch external bindings or entrypoints at all: they're
  "inner", consumed by other primitives via `deps` rather than reached from the
  outside world. Sense-check the model against that inner-primitive case — an
  inner primitive should be a plain `(ctx, deps)` object with none of the
  optional entrypoint methods and no Worker half. If that feels awkward, the
  interface is wrong.
- The Worker side is a GENERIC forwarder + app addressing (ticket 01 resolution),
  not a per-primitive Worker half. So a channel's "contribution" is really its
  DO-side methods plus, for multiplexing, a way to claim which inbound events on
  a shared entrypoint are its own. The split-primitive two-halves seam shrank to
  an escape hatch; don't design a heavy Worker-side registration for channels.

## Resolution

Prototype: [`prototypes/03-channels-abstraction.ts`](../prototypes/03-channels-abstraction.ts).
Glossary: [`CONTEXT.md`](../../CONTEXT.md).

1. **Channel = transport only.** Ingress claim, listener fan-out, and egress
   streaming. Turn policy (instructions, tools, maxTurns, conversation mode) is
   deferred; may later depend on which channel a turn arrived on (two interfaces
   then), not in this design.

2. **Two roles, not one dual type.** `ChannelIn` and `ChannelOut` are roles a
   `Primitive` may implement (either, both, or neither). "Channel" is informal.
   Video-in can be ChannelIn-only; TTS ChannelOut-only; WebSocket both. Inner
   primitives remain plain `Primitive` with no DO methods and no channel roles —
   sense-check passed.

3. **Inbound.** Generic neutral `InboundMessage<TRaw, TReplyTo>` envelope.
   `TRaw` carries typed transport payloads when available; `TReplyTo` carries the
   channel-owned serializable reply target. Transport concepts such as
   conversation ids and thread ids belong in `TReplyTo` or `TRaw`, not on the
   shared envelope. ChannelIn exposes `onMessage`/`unsubscribe` for
   post-construction listener registration (constructor-only `deps.onMessage` is
   insufficient). Channel never knows chat.

4. **Outbound.** `ChannelOut<TTarget>` owns its target type; there is no central
   target union. `openStream(target)` returns a stream with
   `write(UIMessageChunk)`, `complete`, `interrupt`, and `error`. No separate
   one-shot `send` (buffer the stream). The target is always explicit — often
   from `InboundMessage.replyTo`, never required to be; proactive egress is
   first-class. `interrupt` has no string reason for now.

5. **Multiplexing / claim.** In-method claim, no claim registry on
   `PrimitiveHost`. `fetch` → `Response | undefined`; `onEmail` returns claimed.
   Multiple webhook ChannelIns (Slack + Telegram paths) and email coexist on one
   DO.

6. **WebSocket deferred.** The prototype does not model WebSocket channels. A real
   WebSocket channel should preserve compatibility with the existing `Agent`
   websocket frame protocol where possible, likely by lifting the existing
   implementation rather than inventing a toy protocol here. Same-DO WebSocket
   claim/routing remains an implementation detail for the tracer bullet.

7. **Worker→DO.** Generic `host.deliverEmail` (ticket 01 forwarder shape); DO
   fans out; first ChannelIn that claims wins. No per-channel Worker half.

8. **Webhook shape.** Slack/Telegram-style webhooks should be dedicated channel
   classes, not user-configured instances of one generic webhook class; parsing,
   verification, delivery, and target types are transport-specific.

9. **Delivery registration helper.** A helper like `ChannelDirectory` should own
   listener registration and channelId → ChannelOut lookup so users do not wire
   delivery maps by hand.

10. **Storage.** None required. Cursors, address→session maps, outboxes are opt-in
    per channel later. Namespacing remains map fog.
