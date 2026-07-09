# Agent WebSocket protocol inventory (for ticket 05)

Research asset for wayfinder ticket 05 ("WebSocket channel scope for the tracer
bullet"). Inventory of the existing `packages/agents` WebSocket protocol, taken
to decide how much the tracer's WS channel preserves. Facts only; do not port
code from here — ticket 04 is a clean-room implementation of the subset marked
IN SLICE below.

All file:line refs are into `packages/agents` unless noted.

## Transport basics

- JSON string frames, each with a `type` field.
- Upgrade happens in PartyServer's `fetch()` (`node_modules/partyserver/dist/index.js:573`):
  `new WebSocketPair()` (`:589`), connection id from `?_pk` query param else
  `nanoid()` (`:590`), tags from `getConnectionTags` (default `[]`, `:873`),
  then accept, then `onConnect`, then a 101 `Response`.
- Agents accept via the hibernation API by default
  (`Agent.static options = { hibernate: true }`, `src/index.ts:1772`):
  `controller.acceptWebSocket(connection, tags)` (`:243`) plus
  `serializeAttachment({ __pk: { id, tags, uri }, __user })` (`:244-251`).
- Runtime socket APIs (`node_modules/@cloudflare/workers-types/experimental/index.d.ts`):
  `acceptWebSocket(ws, tags?)` (`:713`), `getWebSockets(tag?)` (`:714`),
  `getTags(ws)` (`:720`).
- Single consumer. `webSocketMessage(ws, message)` rehydrates the connection and
  calls one `onMessage(connection, message)`
  (`node_modules/partyserver/dist/index.js:631-637`). There is no multiplexing
  among handlers — an Agent DO has exactly one logical consumer. So there is no
  existing "which channel owns this socket" routing to lift; tags are the only
  relevant existing primitive (connection id is always the first tag; tags are
  otherwise used for broadcast grouping via `getWebSockets(tag)`, `:144`).

## Frame families

### Chat (the slice draws from here) — `src/chat/wire-types.ts`

Inbound (client -> server):

| type                                      | shape                                                                                     | at         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | ---------- |
| `cf_agent_use_chat_request`               | `{ id, init: Pick<RequestInit, ...> }` — `init.body` is JSON `{ messages, trigger, ... }` | `:127-147` |
| `cf_agent_chat_messages`                  | `{ messages: ChatMessage[] }`                                                             | `:148-153` |
| `cf_agent_chat_request_cancel`            | `{ id }`                                                                                  | `:154-158` |
| `cf_agent_chat_clear`                     | `{}`                                                                                      | `:123-126` |
| `cf_agent_tool_result`                    | `{ toolCallId, toolName, output, ... }`                                                   | `:169-190` |
| `cf_agent_tool_approval`                  | `{ toolCallId, approved, ... }`                                                           | `:191-199` |
| `cf_agent_stream_resume_request` / `_ack` | resume handshake                                                                          | `:159-168` |

Outbound (server -> client):

| type                                              | shape                                                                                                                        | at         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `cf_agent_use_chat_response`                      | `{ id, body, done, error?, continuation?, replay?, replayComplete? }` — `body` is a JSON-stringified AI SDK `UIMessageChunk` | `:62-79`   |
| `cf_agent_chat_messages`                          | `{ messages }`                                                                                                               | `:56-61`   |
| `cf_agent_message_updated`                        | `{ message }`                                                                                                                | `:86-91`   |
| `cf_agent_stream_resuming` / `_none` / `_pending` | resume handshake                                                                                                             | `:80-105`  |
| `cf_agent_chat_recovering`                        | `{ recovering, id? }`                                                                                                        | `:106-117` |

One live LLM chunk => one `cf_agent_use_chat_response { body: <chunk>, done:false }`.
Terminal clean frame: `done:true`. Terminal error frame (verbatim from the
replay path): `{ id, body: <errorText>, done:true, error:true }`
(`src/chat/resume-handshake.ts:273-282`).

The live per-chunk emit loop is in `@cloudflare/ai-chat` (`packages/ai-chat`),
not `packages/agents`; only the wire types + resume/replay drivers live here.

### Not in the slice (deferred to the later full-protocol lift)

- Core RPC (`"rpc"`, streaming via `done`) — `src/index.ts:194-230`, `:2380-2450`.
- State sync (`cf_agent_state` / `_error`), `cf_agent_identity`,
  `cf_agent_mcp_servers` — `src/index.ts` + `src/types.ts`.
- Resume/reconnect: `stream_resume_request/ack/resuming/none/pending`, SQLite
  chunk persistence + replay (`cf_ai_chat_stream_chunks` /
  `cf_ai_chat_stream_metadata`) — `src/chat/resumable-stream.ts`,
  `resume-handshake.ts`.
- Recovery: `cf_agent_chat_recovering`, recovery engine — `src/chat/recovery-*`.
- Agent-tool event family (`agent-tool-event`) — `src/agent-tool-types.ts`.
- `cf_agent_session` / `_error` — `src/experimental/memory/session/session.ts`.

## Slice mapping (what ticket 04 builds)

- Inbound: parse `cf_agent_use_chat_request`, pull `id` + `messages` (from
  `init.body`), emit as `InboundMessage`.
- Outbound `openStream({ connectionId, requestId })`, all frames
  `cf_agent_use_chat_response`:
  - `write(chunk)` -> `{ id: requestId, body: JSON.stringify(chunk), done:false }`
  - `complete()` -> `{ id: requestId, body: "", done:true }`
  - `error(err)` -> `{ id: requestId, body: <errorText>, done:true, error:true }`
  - `interrupt()` -> one content frame carrying an AI SDK `{ type:"abort" }`
    chunk (no reason), then `{ id: requestId, body:"", done:true }`
- AI SDK terminal chunk types used: `{type:"finish"}`, `{type:"abort", reason?}`,
  `{type:"error", errorText}` — `node_modules/ai/dist/index.d.ts:2080-2085`.

Everything in the slice is a strict subset of the existing frame shapes: same
`type` strings, same `cf_agent_use_chat_response` fields. What is omitted is a
clean omission, so the later full lift is additive, not a rewrite.
