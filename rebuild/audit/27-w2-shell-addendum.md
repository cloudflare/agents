# 27/W2 addendum — shell, connections, routing: implementation-level spec

Pins the decisions audit 27 §§4-6 left at design level. Scope of W2:
`src/adapters/cloudflare/connection.ts`, `shell.ts`, `routing.ts`, plus
workerd lifecycle/WS tests. Facet spawner and `__call` allowlist are W3.

## 1. `connection.ts`

```ts
export function wrapSocket(ws: WebSocket): Connection;
export function createDurableConnectionRegistry(ctx: DurableObjectState): ConnectionRegistry;
```

- Attachment shape: `{ id: string; state: Record<string, unknown> }` via
  `serializeAttachment`. `wrapSocket` reads it once per wrap;
  `Connection.state` returns a Proxy whose `set`/`deleteProperty` mutate the
  bag and re-serialize the attachment (writes survive hibernation).
- Registry wraps `ctx.getWebSockets()` lazily per call; `get(id)` is
  `ctx.getWebSockets(id)[0]` (id is the accept tag). `broadcast` skips
  excluded ids and `try/catch`es per-socket sends.
- A socket with no/malformed attachment is skipped by the registry
  (defensive; cannot happen through the shell's accept path).

## 2. `shell.ts` — `hostAgent`

```ts
export interface HostAgentOptions<A extends Think<any>> {
  /** Env-dependent construction (model keys etc.). Default: new AgentClass(host). */
  create?: (host: AgentHost, ctx: DurableObjectState, env: unknown) => A;
  /** Non-upgrade HTTP requests. Default: 404. */
  onRequest?: (request: Request, agent: A) => Response | Promise<Response>;
  /** Forwarded to attachChatTransport (readonly, shouldSendProtocolMessages). */
  transport?: AttachChatTransportOptions;
}
export function hostAgent<A extends Think<any>>(
  AgentClass: new (host: AgentHost) => A,
  options?: HostAgentOptions<A>,
): new (ctx: DurableObjectState, env: unknown) => DurableObject;
// usage: export const ChatAgentDO = hostAgent(ChatAgent);
```

**Shell storage keys.** The shell persists its own rows through the same
`DurableKeyValueStore` under the reserved prefix `cf-shell:` (documented in
the file header; no domain module uses it): `cf-shell:name`,
`cf-shell:parentPath`.

**Activation (`#ensure(nameHint?)`).** Lazy — created once per activation,
memoized as a promise; every entry point awaits it. Lazy rather than
constructor-time because the first-ever request carries the name header.
Inside `ctx.blockConcurrencyWhile`:

1. `initial = await ctx.storage.getAlarm()`;
   `timer = createDurableAlarmTimer({ storage: ctx.storage, initial })`.
2. `store = createDurableKeyValueStore(ctx.storage)`.
3. `name = store.get("cf-shell:name") ?? nameHint ?? ctx.id.toString()`;
   persist if it came from the hint. `parentPath` from its row if present.
4. Build `AgentHost` (`className: AgentClass.name`, clock = `Date.now`,
   `onDestroyed` per below), construct the agent (`options.create` or
   `new AgentClass(host)`).
5. `registry = createDurableConnectionRegistry(ctx)`;
   `transport = attachChatTransport(agent, registry, options.transport)`.
6. `await agent.start()`.

**Entry points.**

- `fetch(request)`: `#ensure(request.headers.get("x-agent-name"))`. If
  `Upgrade: websocket` (case-insensitive contains): `new WebSocketPair()`;
  id = `url.searchParams.get("_pk") ?? crypto.randomUUID()`;
  `ctx.acceptWebSocket(server, [id])`; write attachment `{ id, state: {} }`;
  `await transport.onConnect(wrapSocket(server))`; `await timer.flush()`;
  return `new Response(null, { status: 101, webSocket: client })`.
  Non-upgrade → `options.onRequest?.(request, agent)` ?? 404.
- `webSocketMessage(ws, message)`: `#ensure()`; ignore non-string frames;
  `await transport.onMessage(wrapSocket(ws), message)`; `await timer.flush()`.
- `webSocketClose(ws)`: `#ensure()`; `transport.onClose(wrapSocket(ws))`.
- `alarm()`: `#ensure()`; `timer.onPlatformAlarm()`; `await agent.onAlarm()`;
  `await timer.flush()`. Errors from `onAlarm` propagate (platform retry).
- RPC methods (the class extends `DurableObject` from `cloudflare:workers`):
  - `__init(init: { name: string; parentPath?: AgentHost["parentPath"] })` —
    idempotent identity bootstrap: persists the rows if absent; throws
    `Error` if a DIFFERENT name is already persisted. Must work before
    `#ensure` has ever run (it writes the rows the next `#ensure` reads); if
    the agent already started under a fallback name, same-name `__init` is a
    no-op.
  - `__destroy()` — `#ensure()` then `agent.destroy()`. The host's
    `onDestroyed`: close every registered socket (code 1001), `timer.clear()`
    + `await timer.flush()`. (No `ctx.abort()` in W2 — noted as production
    hardening for later.)

**Note on `timer.flush()`**: best-effort determinism at entry-point exits;
writes enqueued by a turn that outlives the handler are still covered by
workerd output gates.

## 3. `routing.ts`

```ts
export async function routeAgentRequest(
  request: Request,
  env: Record<string, unknown>,
  options?: { prefix?: string },          // default "agents"
): Promise<Response | undefined>;         // undefined = not an agent URL
export async function getAgentByName(
  namespace: DurableObjectNamespace, name: string,
): Promise<DurableObjectStub>;            // __init({ name }) then the stub
```

- Path `/{prefix}/{binding}/{name}` (extra trailing segments/query preserved
  on the forwarded request). Binding segment matches an env entry that
  exposes `idFromName`, comparing the segment case-insensitively against
  both the binding name and its kebab-case (`MyAgent` ⇔ `my-agent`).
- Forward: `idFromName(decodeURIComponent(name))`, clone request with
  `x-agent-name: <name>` added, `stub.fetch(...)`. No match → `undefined`.

## 4. W2 workerd tests (`test-workers/`)

Test worker additions: `ChatAgent extends Think` overriding `getModel()`
with a scripted in-worker `ModelClient` (import `FakeModel` from
`src/adapters/memory/fake-model.js` — pure TS, runs in workerd; or an inline
scripted client), exported as `export const ChatAgentDO = hostAgent(ChatAgent)`
— bound + `new_sqlite_classes` in wrangler.jsonc. Default export routes via
`routeAgentRequest`.

Client-side helper: `SELF.fetch("https://x/agents/chat-agent-do/main?_pk=c1",
{ headers: { Upgrade: "websocket" } })` → `response.webSocket.accept()`,
collect messages into an array, `await`-poll with timeout for expected frames.

Tests:
1. Upgrade through the router yields 101 + the `cf_agent_identity` /
   `cf_agent_chat_messages` handshake; identity carries the routed name
   (`main`) — proving header-based identity persistence.
2. `cf_agent_use_chat_request` streams `cf_agent_use_chat_response` chunks
   and ends with `cf_agent_message_updated`; a second turn works (queue).
3. Reconnect (same name, new `_pk`) receives the persisted history in its
   `cf_agent_chat_messages` resync — real-storage persistence through Think.
4. Two concurrent sockets: `cf_agent_state` set from socket A is delivered
   to socket B and NOT echoed to A (origin echo-exclusion over real sockets).
5. `cf_agent_stream_resume_request` while idle → `cf_agent_stream_resume_none`.
6. Lifecycle: an RPC test method on the DO subclass... RPC methods live on the
   shell class; for test-only agent calls add them via a small subclass of the
   generated class (`class TestChatAgentDO extends hostAgent(ChatAgent) { ... }`
   — the factory's return must permit subclassing) with a method that calls
   `agent.schedule(1, "noteFired", {})` (the ChatAgent has a `noteFired`
   method writing a storage row); then `runDurableObjectAlarm` → row exists —
   scheduler over the real alarm slot.
7. `__destroy` wipes: after chatting, `__destroy()`, then a fresh socket's
   resync shows empty history.

(The full node-suite WS behaviors — readonly, client tools, approvals over
frames — are already covered against the same adapter in the node run; the
workerd e2e proves the platform seams, not the protocol matrix.)

## 5. Constraints (unchanged from audit 27)

Frozen: `src/app/`, `src/domain/`, `src/kernel/`, `src/ports/*.ts`,
`src/adapters/memory|websocket-chat|anthropic|node|relay`. The shell must
expose the agent to tests ONLY through platform surfaces (fetch/WS/RPC/alarm)
— never by exporting the instance. TDD; all of `npx vitest run` (>= 1050),
`npm run test:workers`, `npm run typecheck` green at the end.
