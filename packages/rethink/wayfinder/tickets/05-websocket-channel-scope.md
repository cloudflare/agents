# WebSocket channel scope for the tracer bullet

Type: research+grilling
Status: closed
Blocked by: 01, 03

## Question

What does the WebSocket channel in the tracer bullet actually implement?

Ticket 03 locked ChannelIn/ChannelOut as transport roles and deliberately omitted
a WebSocket prototype, so we would not invent a toy frame protocol. The tracer
bullet (ticket 04) still needs a WebSocket channel coexisting with Email on one
bare DO. This ticket scopes that channel before any code lands.

Settle:

1. **Protocol surface** — How much of the existing `Agent` / chat WebSocket frame
   protocol do we preserve for the tracer? Options range from:
   - thin transport only (upgrade + tagged sockets + raw/envelope frames, no
     chat RPC/resume protocol), through
   - a compatibility slice of the current Agent WS frames sufficient for
     connect/message/stream, through
   - lifting the full existing protocol into a ChannelIn/ChannelOut shape.
2. **Claim and routing** — How does this channel claim upgrades and later frames
   under the ticket 01/03 model (path claim on `fetch`, hibernation tags or
   equivalent for `webSocketMessage`/`Close`/`Error`)? Multiple WS channel
   objects on one DO vs one WS channel for the tracer.
3. **Serializable OutTarget** — What is the channel-owned reply target after
   eviction/hibernation (connection id + tags, attachment metadata, etc.)?
4. **Outbound** — How does `openStream` map `UIMessageChunk` onto the chosen
   frame protocol (including complete / interrupt / error)?
5. **Tracer cut line** — Exactly what is in scope for ticket 04 vs deferred
   (resume, RPC/callable frames, state protocol, multi-socket chat, etc.).

Reference existing code for protocol inventory only; do not port it here:
`packages/agents` WebSocket/PartyServer paths and `packages/agents/src/chat/`
transport frames. Produce a short decision note (and optional sketch) linked
from this ticket. Implementation is ticket 04.

## Notes carried from tickets 01 and 03

- Primitives are plain `(ctx, deps)` with optional DO-shaped methods; host is
  dispatch-only `PrimitiveHost`.
- ChannelIn/ChannelOut are roles on Primitive; inbound is
  `InboundMessage<TRaw, TReplyTo>` with post-construction `onMessage`; outbound
  is `openStream(target)` writing `UIMessageChunk`.
- No required channel storage. Prefer serializable targets over holding live
  `WebSocket` objects across hibernation.
- Prefer compatibility with existing Agent WS frames where possible over a clean
  break that forces client rewrites for the tracer.

## Resolution

Protocol inventory: [`research/05-agent-ws-protocol-inventory.md`](../research/05-agent-ws-protocol-inventory.md).
The tracer's WebSocket channel implements a **compatibility slice** that is a
_precise subset_ of the existing `packages/agents` protocol — same `type`
strings, same frame fields — so the omitted parts are clean omissions and the
eventual full-protocol lift is additive, not a rewrite.

1. **Protocol surface — compatibility slice.** Connect + inbound
   `cf_agent_use_chat_request` + outbound `cf_agent_use_chat_response` (body = a
   JSON-stringified AI SDK `UIMessageChunk`, `done` flag). The existing
   `WebSocketChatTransport` client drives a plain turn unmodified. Resume, RPC,
   state sync, recovery, agent-tools, history sync, and tool frames are out.
   Must stay a strict subset of the original wire, not an accidental deviation.

2. **Claim and routing — tag-based self-claim, in-method.** The existing stack
   has no multi-consumer socket routing to copy (single `onMessage`); its only
   relevant primitive is hibernation tags. Upgrade: the channel claims in
   `fetch` (path + `Upgrade: websocket`), creates the `WebSocketPair`, calls
   `ctx.acceptWebSocket(server, [channelId, connId])`, returns 101 — the ticket
   01 chain-of-responsibility already routes the upgrade to it. Frames: the host
   fans `webSocketMessage`/`Close`/`Error` to every primitive; each WS channel
   self-filters by `ctx.getTags(ws).includes(this.channelId)`. No routing state
   on `PrimitiveHost` (ticket 03's in-method claim, applied to sockets).

3. **Serializable OutTarget — `{ connectionId, requestId }`.** Two serializable
   strings, survives hibernation (per ticket 03's preference over live sockets).
   `connectionId` is the socket's id tag; `openStream` re-resolves the live
   socket lazily via `ctx.getWebSockets(connectionId)` (none = connection gone,
   no-op for the tracer). `requestId` echoes the inbound request `id` and stamps
   every response frame so the client correlates the stream.

4. **Outbound — map onto existing frames via chunk types.** All frames are
   `cf_agent_use_chat_response`; the terminal distinction rides inside `body` as
   the AI SDK chunk type, so no new frame shape is invented.
   - `write(chunk)` → `{ id: requestId, body: JSON.stringify(chunk), done:false }`
   - `complete()` → `{ id: requestId, body:"", done:true }` (the caller's own
     stream already carried the `finish` chunk)
   - `error(err)` → `{ id: requestId, body:<errorText>, done:true, error:true }`
     (byte-for-byte the existing terminal-error frame,
     `resume-handshake.ts:273-282`)
   - `interrupt()` → one content frame carrying an AI SDK `{ type:"abort" }`
     chunk (no reason, per ticket 03), then `{ id: requestId, body:"", done:true }`

5. **Tracer cut line.** IN: `fetch` upgrade claim (hibernation
   `acceptWebSocket`, required — ws frames only arrive as real DO methods under
   hibernation, ticket 01); `webSocketMessage` self-filter + parse
   `cf_agent_use_chat_request` → `InboundMessage` → `onMessage`;
   `webSocketClose`/`Error` self-filter + cleanup; `openStream` per decision 4;
   coexistence with the Email channel on one DO extending `PrimitiveHost`; a
   vitest-pool-workers test proving connect → request → streamed responses →
   `done:true`, plus email in/out, both non-colliding. DEFERRED to the later
   full lift / fog: resume/reconnect, recovery, RPC/callable, state/identity/mcp,
   agent-tool events, `cf_agent_chat_messages` history sync,
   `tool_result`/`tool_approval`/`clear`, client→server
   `cf_agent_chat_request_cancel`, multi-connection broadcast.

Ticket 04 (tracer bullet) is now unblocked. The full-protocol lift is recorded
out of scope on the map.
