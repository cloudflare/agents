# Issues

Lightweight local tracker for known gaps and deferred work surfaced while building
and domain-modeling the clean-room rebuild. Just enough to not lose the thread —
not a replacement for a real tracker. Resolve or delete entries as they're
addressed.

Use this for *gaps to fix later*. Decisions we're happy to stand behind go in
[`docs/adr/`](./docs/adr/) instead.

**Status:** `open` · `in-progress` · `resolved`

---

## ISSUE-001 — Reasoning is output-only; not replayable to providers that support it

**Status:** open · **Area:** Conversation + Infrastructure (`ModelMessage` port)

The `ModelMessage` port carries reasoning on the way *out* (`ModelChunk`
`reasoning-delta`) but has no reasoning variant on the way *in* — assistant
`content` is `text | tool-call` only. So `toModelMessages` drops reasoning, and no
adapter can resend it. This bakes a provider assumption — "no provider accepts
reasoning back" — into the domain contract, which is **false**: Anthropic
(interleaved thinking, signed) and OpenAI (reasoning items) replay reasoning in
multi-step tool flows.

Reasoning is still persisted on the `ChatMessage` and streamed to clients; only
*provider replay* is missing.

This is also a real gap in the original Think implementation, though the failure
mode is narrower there. Original Think routes assistant reasoning through the AI
SDK's `convertToModelMessages`, which can replay reasoning when the persisted
part still contains the provider metadata. However, its persistence sanitization
strips OpenAI's ephemeral `reasoningEncryptedContent` (and `itemId`) before the
message is stored. A later turn therefore cannot faithfully replay OpenAI
reasoning, even though the in-memory conversion path supports reasoning content.
The rebuild currently regresses this further by dropping all reasoning at the
domain `ModelMessage` boundary, regardless of provider.

Correct handling (deferred):
- Add a reasoning variant to assistant `ModelMessage` content, carrying the
  provider's opaque/signed payload — not just display text (today's reasoning part
  is `{ type: "reasoning"; text }`, insufficient for faithful replay).
- Capture that payload at generation time.
- Move the drop/keep decision into the per-provider adapters (filter if
  unsupported) rather than dropping unconditionally in the domain.

Not an ADR: this is a gap to fix, not a decision to enshrine.

---

## ISSUE-002 — Channels hard-codes an implicit "web" channel

**Status:** resolved · **Area:** Channels (`src/domain/channels/`)

Dropped `IMPLICIT_WEB` and the `kind === "web"` special case. The transcript is now
the default delivery sink; `web` is just a normal (optional) channel; a channel with
no `deliver` hook falls back to the transcript (the uniform sub-choice, replacing the
old out-of-turn throw). Channels glossary DRAFT lifted.

---

## ISSUE-003 — Consume the MCP client stack behind `ExternalToolSource`

**Status:** open · **Area:** Integration ([audit 28](./audit/28-reuse-vs-reimplement.md) Tier 2 #1)

The original's MCP client (`agents/src/mcp/` minus the `McpAgent` server class,
~6.9k LOC: transports, OAuth provider, x402, connection lifecycle) imports nothing
from Agent — its only internal dep is the standalone `core/events` util. The
rebuild's `ExternalToolSource` port is the reserved seam and is currently
unimplemented. Vendor the client + `core/events`, write a thin adapter mapping
`ready/listTools/callTool` onto it. Highest-value consumption: fills a real gap
with zero re-implementation. (The `McpAgent` *server* half extends Agent and is
explicitly NOT consumed — re-implement on the shell if wanted.)

---

## ISSUE-004 — Consume `@cloudflare/codemode` behind the `Sandbox` port

**Status:** open · **Area:** Integration (audit 28 Tier 1)

Zero coupling to Agent/Think (verified); needs only a `DurableObjectState`, which
the DO shell has. Take it as a plain npm dependency. Two seams: a `Sandbox` port
adapter (`ports/sandbox.ts` is reserved and unimplemented), and/or a codemode tool
provider (its raw-JSON-schema `ConnectorTool` shape matches our tool shape).
Prerequisite for ISSUE-005 and for the original skills runner as an alternative
`SkillSource` backend.

---

## ISSUE-005 — Consume `@cloudflare/shell` as a workspace adapter

**Status:** open · **Area:** Integration (audit 28 Tier 1)

Zero runtime coupling to Agent/Think (only its test fixtures import `agents`);
plugs into codemode via `StateConnector`, needs a `StateBackend` + DO state. Do
NOT swap tool layers wholesale: keep `domain/workspace` as the port and add a
shell-backed adapter implementing it, which brings the richer capabilities
(git via isomorphic-git, bash) behind our existing seam. Depends on ISSUE-004.

---

## ISSUE-006 — Consume the `think/extensions/` plugin seam

**Status:** open · **Area:** Integration (audit 28 Tier 2 #2)

The designed plugin seam is genuinely clean: `ExtensionManager` takes a pure
options object (`WorkerLoader`, storage, `createHostBinding`); extensions are
sandboxed Workers with a manifest/permissions contract; the host implements a
fixed 9-method `_host*` bridge (read/write/delete/list files, get/set context,
get messages, send message, session info). Lift the manager + host bridge,
implement the 9 methods over rebuilt Think (workspace + session + context
blocks), wire `WorkerLoader` in the Cloudflare shell. The host-bridge's
parent-DO resolution (class-name + id) needs adapting to the shell's identity
scheme. New capability — no overlap with existing modules. `worker-bundler`
becomes relevant here (dev-time bundling for extension workers).

---

## ISSUE-007 — Consume the existing browser/React client as-is (compat smoke test)

**Status:** open · **Area:** Integration (audit 28 Tier 2 #3)

`agents/src/client.ts` + `react.tsx` couple to the core by types only — they
depend on the `cf_agent_*` protocol vocabulary (`MessageType` enum) we
deliberately preserved. Consumption here means *proving* the existing published
client works unmodified against the rebuild's WS adapter + shell: the deferred
`agents/react` smoke test (drive `useAgent`/`useChat` at a workerd-hosted rebuilt
Think). Also the forcing function for ISSUE-008-adjacent gaps: client-supplied
message-array reconciliation (audit 28 appendix #2) will surface here.

---

## ISSUE-008 — Consume `agents/src/browser/` (CDP browser automation tools)

**Status:** open · **Area:** Integration (audit 28 Tier 2 #4)

~3.1k LOC, exactly one coupling line: an optional `agentContext` ALS fallback to
reach `agent.ctx`, already bypassed by passing `ctx` in `CreateBrowserToolsOptions`.
Vendor it, drop the ALS fallback, expose through our tool shape (its AI-SDK-entry
tools convert cheaply now that adapters have `ai` v6). Needs the Browser
Rendering binding in the shell/demo wrangler config.

---

## ISSUE-009 — Consume the `observability/` interface as an EventBus adapter

**Status:** open · **Area:** Integration (audit 28 Tier 2 #5)

Pure `emit(event)` interface + `node:diagnostics_channel` fan-out, zero Agent
coupling. Cheap adapter bridging our kernel `EventBus` onto its named channels
(`agents:state|rpc|message|chat|transcript`) so existing observability consumers
work against the rebuild. Low effort; do whenever standardized observability is
wanted.

---

## ISSUE-010 — Consume `@cloudflare/voice` via a shell-level facade

**Status:** open · **Area:** Integration (audit 28 Tier 1)

`withVoice(Base)` is a mixin needing only `Pick<Agent, "sql" | "getConnections" |
"keepAlive">` + `onConnect`/`onMessage` override points and `Connection`/`WSMessage`
types; it runs its own `voice_*` WS protocol (not `cf_agent_*`). Voice is
transport-adjacent, so in the rebuild it belongs at the SHELL: a compatibility
facade exposing `sql` (real DOs have `ctx.storage.sql`), `getConnections` (durable
connection registry), `keepAlive` (Agent's keep-alive service), and
connect/message hooks. Moderate glue, architecturally consistent — the agent
class stays transport-free.

---

## ISSUE-011 — Consume `think/messengers/` (+ `channels/` glue)

**Status:** open · **Area:** Integration (audit 28 Tier 2 #6)

Decoupled behind its self-defined `MessengerThinkHost` interface (fibers +
sub-agents + `StreamCallback`), all of which the rebuild has. Lift when a real
messenger surface (Telegram etc.) is needed: implement `MessengerThinkHost` over
rebuilt Think, keep `channels/index.ts` as the typed glue. Watch the
`StreamCallback`/`ChatStartEvent` shapes (ours are structurally compatible) and
its `RpcTarget` (Workers RPC) assumption.

---

## ISSUE-012 — Consume `hono-agents` (router type shim)

**Status:** open · **Area:** Integration (audit 28 Tier 1)

86 lines; couples to exactly two symbols: `routeAgentRequest` (our Cloudflare
`routing.ts` already matches the shape — Response with `webSocket`) and the
`AgentOptions` type. Either publish a compatible type + re-point the peer dep, or
rewrite the middleware (~20 min). Decide when Hono users show up.

---

## ISSUE-013 — Consume `think/framework/` build tooling when a CLI/scaffolding story lands

**Status:** open · **Area:** Integration (audit 28 Tier 2 #7)

Project discovery/config/codegen (~1.7k LOC), zero runtime coupling — operates on
files, not agent instances. Portable as-is (together with `think/server-entry.ts`'s
generated-entry contract) whenever the rebuild grows a `create-think`-style
developer experience. No action until then.

---

## ISSUE-014 — Re-implement aged-media eviction

**Status:** open · **Area:** Conversation/Session (audit 28 appendix #1)

Original: `think/media-eviction.ts` (253 LOC). Long-lived sessions accumulate
inline base64 media (screenshot tool results, data-URL attachments) in the
persisted transcript; read-time truncation hides it from the model but never
reclaims storage. Re-implement as a session/store housekeeping pass (age
threshold → strip/replace media parts in persisted messages, keep a stub marker).
Natural home: `domain/session` maintenance alongside compaction, driven by the
scheduler's internal housekeeping.

---

## ISSUE-015 — Re-implement client message reconciliation on persistence

**Status:** open · **Area:** Conversation (audit 28 appendix #2)

Original: `agents/chat/message-reconciler.ts` — pure functions aligning
CLIENT-supplied message arrays with server state (merge server-known tool outputs
into stale client copies, dedupe/align ids) before persisting. The rebuild's
`chat(messages[])` path persists what it is given, which corrupts server-side
tool state for useChat-style clients that round-trip full arrays. Small and pure —
port the strategy set into `domain/messages` (it may be near-liftable despite the
re-implement label). Gate for ISSUE-007 (real-client compat).

---

## ISSUE-016 — Re-implement the workflow-side base class (`AgentWorkflow`)

**Status:** open · **Area:** Workflows (audit 28 appendix #3)

Original: `agents/workflows.ts` (619) + `workflow-types.ts` + `think/workflows.ts`
(293). The rebuild has agent-side tracking (audit 20) and the runtime binding
adapter (W4) but nothing workflow authors extend: a `WorkflowEntrypoint` subclass
that routes progress/step events back to the originating agent (the original
augments create-params with `__agentName`/`__agentBinding`/`__agentOrigin` for the
return path). Design the return path against the rebuild's typed surface
(`getAgentByName` + `__call`) rather than the original's binding lookup.

---

## ISSUE-017 — Re-implement sub-agent external routing

**Status:** open · **Area:** Infrastructure/Cloudflare (audit 28 appendix #4)

Original: `agents/sub-routing.ts` (335 LOC) — `routeSubAgentRequest`, URL
addressability for facet children. Rebuild children are parent-mediated only
(`__call` via the spawner). Extend `adapters/cloudflare/routing.ts` + shell with a
path scheme addressing a child through its root DO (the root must resolve the
facet and forward), including WebSocket upgrade pass-through to a child's chat.

---

## ISSUE-018 — Pre-stream resume window: park, don't `resume_none`

**Status:** resolved (2026-07-15) — see resolution note at end · **Area:** Conversation/Transport (audit 28 appendix, partial)

Original: `agents/chat/pre-stream-turns.ts`. Between "request accepted" and
"first chunk streamed" a resume request finds no active stream; the original
parks the connection and attaches it when the stream starts. The rebuild's WS
adapter answers `cf_agent_stream_resume_none` in that window, so a client that
reconnects immediately after submitting can miss the turn start (it still gets
the settled message via `message:updated`). Fix in `adapters/websocket-chat`:
treat queued-but-not-started turns as resumable (the event log + turn state
already know about them).

Resolution: the adapter now implements the original handshake — on connect
with an active stream it sends STREAM_RESUMING {id} and suppresses the
CHAT_MESSAGES resync; replay is ACK-gated (`cf_agent_stream_resume_ack`) and
starts at the first delta; #1645 terminal outcomes are retained in
turn-state (written by recovery terminalize, cleared eagerly at new-turn
submit and on clearMessages, exposed via `Think.pendingChatTerminal()`) and
delivered over the handshake as a raw-body error frame. Delta chunks now
carry streaming part ids ("t1", ...) that real clients key text parts by.
Acceptance: onconnect-broadcast 7/9 (the 2 others are /sub/ routing —
ISSUE-017).

---

## ISSUE-019 — Tool-output depth truncation + persistence sanitization parity

**Status:** open · **Area:** Messages/Session (audit 28 appendix, partial; extends the known row-size gap)

Original: `agents/chat/tool-output-truncation.ts` (depth/size-limited tool output
shrinking) and `chat/sanitize.ts` (strip ephemeral provider metadata, enforce row
size before SQLite writes). The rebuild truncates in `messages/store`,
`actions`, and `fetch`, but has no depth-limited generic tool-output pass and the
row-size guard is not wired into the session persistence path (known gap since
the Think-composition wave). Consolidate: one sanitize/truncate pass at the
session append seam.

---

## ISSUE-020 — General `retry()` utility (+ queue retry parity)

**Status:** open · **Area:** Durable Runtime (audit 28 appendix, minor)

Original: `agents/retries.ts` (308 LOC) — shared `RetryOptions` + backoff engine
behind `schedule()`, `scheduleEvery()`, `queue()`, and a public `this.retry(fn)`.
The rebuild's scheduler has `RetryPolicy` and the task queue tracks attempts, but
there is no public retry helper and queue retry semantics are thinner. Port the
backoff vocabulary once into `kernel/` or `domain/runtime` and expose
`Agent.retry()`.

---

## ISSUE-021 — Type-level `Serializable<State>` constraint

**Status:** open · **Area:** Durable Runtime/State (audit 28 appendix, minor)

Original: `agents/serializable.ts` — a compile-time type that rejects
non-JSON-round-trippable state (functions, Dates, bigints...) at the type level.
The rebuild validates at runtime only. Cheap DX win: add the conditional type and
apply it to `Agent<State>`'s state surface without changing runtime behavior.

---

## ISSUE-022 — Re-implement an MCP *server* story on the shell

**Status:** open · **Area:** Integration/Shell (audit 28: `McpAgent` is re-implement)

The original `McpAgent` extends Agent (storage, `getConnections`, elicitation
hook) to expose an agent as an MCP server. Not consumable (ISSUE-003 covers the
client half only). When wanted: a shell-level adapter exposing a rebuilt agent's
tools/callables over MCP transports, reusing the vendored transport code from
ISSUE-003. Design question: which surface (callables registry? tool set?) maps to
MCP tools.

---

## ISSUE-023 — Re-implement inbound email routing

**Status:** open · **Area:** Infrastructure/Cloudflare (deferred at W4)

W4 shipped outbound `EmailTransport` only. The original also routes inbound email
to agents (`routeAgentEmail` + resolver strategies + HMAC-signed reply headers in
`agents/email.ts`, reply/forward via an `EmailBridge` RpcTarget). Re-implement on
the rebuild: an email routing helper resolving agent class+name from the
message, an `onEmail` typed entry point on the shell, and signed reply support.

---

## ISSUE-024 — Public Think entry point for delegation run reconciliation

**Status:** open · **Area:** Delegation (known gap since the e2e wave)

`AgentToolRunService.reconcile()` (settle parent-side `running` rows against
children's real terminal state on startup) has no public Think method — e2e
drives the domain service directly. Expose it (likely inside `onStart`, mirroring
scheduled-task reconciliation) so recovery after eviction is automatic.

---

## ISSUE-025 — WebMCP bridge (parked)

**Status:** open · **Area:** Integration (audit 28 appendix #5)

`agents/experimental/webmcp.ts` bridges `navigator.modelContext` (Google's WebMCP
browser API). Marked do-not-use-in-production upstream and the API is unstable.
Tracked for completeness only — no action until the platform API stabilizes;
revisit alongside ISSUE-003's transport vendoring.

---

## ISSUE-026 — Wire compat is name-level, not payload-level

**Status:** resolved (2026-07-15) · **Area:** Transport (`adapters/websocket-chat`) — found by the test-port audit ([audit 29](./audit/29-test-coverage-port.md) §1)

Resolved: the adapter now speaks the original payloads as canonical — accepts
the `init.body` request envelope (legacy direct fields still work), emits
`{id, body, done, error}` chunks with terminal `done` on settle (suspended
turns keep the stream open, EXCEPT durable-pause which is terminal per the
original's execute-hitl semantics), and broadcasts a full
`cf_agent_chat_messages` resync after settle. Native tests + demo page
converged. T0 gates green (streaming-message-id 1/1, assistant-agent 5/5).

We kept the `cf_agent_*` frame NAMES but the original payload envelopes differ:
the original chat request wraps its payload as `{ id, init: { method: "POST",
body: JSON.stringify({ messages, ...}) } }` (ours reads `frame.messages`
directly); original response chunks are `{ id, body, done, error }` with a
terminal `done` (ours emits `{ id, chunk }` with no done framing); RPC/resume
field shapes need the same audit. Until fixed, the real `agents/react` client
(ISSUE-007) and every copy-paste WIRE test will fail on framing rather than
behavior. Fix is adapter-only (accept `init.body`, emit `body`/`done`), with two
ported original tests (`streaming-message-id`, `assistant-agent`) as the
acceptance gate — audit 29 track T0.

---

## ISSUE-027 — Interaction-driven continuations minted fresh requestIds

**Status:** resolved (2026-07-15) · **Area:** app/think (`continueLastTurn`)

Found by the ported approval-flow tests: a turn resuming after
applyToolResult/resolveApproval is the SAME turn per the audit 25 statechart
(suspended → queued), and recovery continuations already reuse
`incident.requestId` — but `continueLastTurn` generated a new id, so the
continuation's chunks and terminal `done` arrived under an id the client
never saw, orphaning the request stream at the wire. Fixed: the continuation
keeps the suspended turn's requestId.

---

## ISSUE-028 — Session append could create a parent cycle → synchronous infinite loop

**Status:** resolved (2026-07-15) · **Area:** Conversation/Session (`domain/session`)

Found by the ported message-reconciliation suite (which wedged entire workerd
isolates so hard that vitest timeouts never fired). `appendMessage` blindly
re-parented an already-stored message id onto the current leaf; clients that
round-trip full message arrays (every useChat-style client) re-send existing
ids, creating a parent cycle that `rawHistory`'s chain walk followed forever
— a synchronous infinite loop inside the DO. Fixed: re-appending a known id
refreshes content in place without re-parenting, and `rawHistory` gained a
seen-set cycle guard (corruption degrades to truncated history, never a
hang). Regression test in `domain/session/session.test.ts`. Full
reconciliation semantics remain ISSUE-015.

---

## ISSUE-029 — Approval-state vocabulary parity (`approval-responded`, `output-denied`)

**Status:** resolved (2026-07-15) · **Area:** Messages/Actions/Conversation

The original's tool-part lifecycle includes `approval-responded` (approved,
pre-re-execution) and `output-denied` (denied with reason) states; the
rebuild's `ToolPart` union stops at `approval-requested` ->
`output-available`/`output-error`, mapping denials onto `output-error`. Four
ported client-tools tests assert the richer vocabulary (they false-passed
before the P1 fixture was fixed to use the real session). Add the two states
to `ToolPart`, set them in the pendingInteractions approval resolution, and
rank them in reconcile/accumulator state ordering.

Resolved: `ToolPart` gained both states; client-approval resolution now sets
`approval-responded` for approved CLIENT tools (server-executable tools still
re-execute) and `output-denied` (with reason) for denials; tool results
apply to `approval-requested`/`approval-responded` parts but never to denied
ones; denied counts as settled for auto-continuation; reconcile ranks and
repair's unsettled set updated. Native denial assertions migrated.

---

## ISSUE-030 — Hosting refactor: one generic DO host + composed capability-typed transports

**Status:** open · **Area:** Cloudflare adapter / hosting (audit 30 §composition-tiers)

`hostAgent` is the Cloudflare primary adapter (the DO class that supplies
concrete ports over `ctx.storage`/`setAlarm` and drives start-once / alarm /
fetch-WS / `__call` RPC). Today it is typed `<A extends Think>` and always
wires `attachChatTransport` (the `cf_agent_*` WS protocol), conflating the
UNIVERSAL adapter role with CHAT-specific transport wiring. Consequence: a
primitives-first agent (`extends Agent`, no chat — e.g. scheduled-task-only or
RPC-only) has no hosting path, and if forced through `hostAgent` would carry
chat plumbing it never uses. So the "compose your own on `Agent`" tier
(audit 30) is real at the composition layer but missing its hosting layer.

Fix (chosen shape — COMPOSITION-first, helpers are opt-in). The truest model
is plain composition: **the DO has-a Agent** (nested), not the agent being/
extending the DO, and not a factory hiding the has-a. Replace the `hostAgent`
factory + its throwing-stub base (`HostedAgentDurableObject`, whose methods
throw "hostAgent did not install …" until the factory subclass overrides them —
a two-level indirection more mysterious than a mixin) with a spectrum the
author picks from, composition primary:

1. **Plain composition (the documented conceptual model).** The author writes
   an ordinary DO that owns a lifecycle *driver* which owns the agent:
   ```ts
   export class MyDO extends DurableObject {
     #rt = createAgentRuntime(this.ctx, this.env, (rt) => new MyAgent(rt), { transports: [conversationProtocol()] });
     fetch = this.#rt.fetch; alarm = this.#rt.alarm;
     webSocketMessage = this.#rt.webSocketMessage; webSocketClose = this.#rt.webSocketClose;
   }
   ```
   The has-a relationship is fully visible; `createAgentRuntime` owns only the
   subtle, identical-across-agents part (see below), not the composition.
2. **Optional convenience base class** for zero forwarding lines —
   `AgentDurableObject<A extends Agent>`, `createAgent(rt)` the one seam. It is
   a GENERIC host that routes platform I/O (fetch/alarm/ws) to **composed
   transport adapters**; what the DO speaks is composed in, NOT a property of
   the agent's type.

   **No "chat" type, no `instanceof Think` (correction, 2026-07-15).** "Chat"
   is not a coherent agent boundary — it's a client-protocol bundle. The
   `cf_agent_*` WS adapter fuses four concerns, and three are already
   Agent-level (grep-confirmed): event-log→wire projection (`events()`), state
   sync (`setState`/`state`), RPC dispatch (`callables`) — all on `Agent`;
   only the conversation-turn surface (`chat`/`history`/`applyToolResult`/
   `resolveApproval`/`isRecovering`/`activeTurn`/`pendingChatTerminal`/
   `clearMessages`/`cancelChat`) is on `Think`. So gating the host on
   `instanceof Think` is the wrong axis — it would deny a plain `extends Agent`
   its *generic* transports (streaming, RPC) that work on any agent. ("Agent
   knows nothing about chat" was never a design goal — the goal (audit 25) was
   transport-freedom; the outbound event log is itself on Agent.)

   Compositional model instead: the author composes the transports their agent
   supports, each requiring its capabilities STRUCTURALLY (an interface), not a
   class identity:
   ```ts
   class SupportAgentDO extends AgentDurableObject<SupportAgent> {
     createAgent(rt) { return new SupportAgent(rt); }
     transports() { return [conversationProtocol()]; }  // requires the turn surface
   }
   class ReminderDO extends AgentDurableObject<ReminderAgent> {
     createAgent(rt) { return new ReminderAgent(rt); }
     transports() { return [rpcProtocol()]; }           // requires only callables
   }
   ```
   `rpcProtocol()`/`stateProtocol()` type-check against any `Agent`;
   `conversationProtocol()` type-checks against a `ConversationApi`
   **interface** (the turn methods it calls), NOT the concrete `Think` class —
   an interface has no private brand, so a userland composition implementing
   those methods satisfies it too (ADR-0002 corollary). Today
   `attachChatTransport(agent: Think)` leaks this: Think's private fields make
   the parameter nominal and reject userland compositions — fix it in this
   refactor. The `cf_agent_*` browser
   bundle ships as ONE composable transport today, DECOMPOSABLE later into
   event-projection / state-sync / rpc / conversation sub-transports (the seams
   are already real). Think is not a different *kind* of thing — it's `Agent` +
   composed conversation modules, hosted by the same generic host.
3. **`hostAgent(A)` factory** kept as the tersest one-line sugar.

Why the driver/helper is more than "forward 4 methods": the lifecycle wiring is
**activation-scoped async setup that's identical everywhere and easy to get
subtly wrong** — `start()` exactly once per activation inside
`blockConcurrencyWhile` AND lazily (identity can arrive on the first request
header, not at construction); alarm-mirror restore from `getAlarm()` + flush;
WS hibernation re-attaching the transport on wake. That subtlety is what the
helper owns so the visible composition stays trivial. (This is why a naive
`#agent = new MyAgent(...)` field alone is insufficient — start is async and
activation-scoped.)

Two invariants: (a) the AGENT stays a separate class constructed over a NARROW
capability object (port-pure, node-testable) — never the DO, never handed
`this`/`ctx`; (b) rename `AgentHost` → something signalling
capabilities-not-runtime-handle (candidate: `AgentRuntime`; it is identity +
capability-ports, and its type must obviously be an *assembled set*, so "pass
`this`" never reads as valid). The bundle is already narrow today (no `ctx`/
`this`); the fix is naming + the driver split. Layering (minimal vs chat) and
the primitives-first hosting path fall out of #1/#2. Pairs with a
"build-a-lite-agent" DX pass (domain factories are public + test-proven but
their dep signatures are internal-facing) and the framework/Vite codegen
(ISSUE-013) that generates #2/#3 away.

**Update (2026-07-15, ADR-0002 accepted):** the inbound seam splits by layer
— `conversationProtocol()` types against `ConversationApi` (essence: chat/
cancelChat/applyToolResult/history/clearMessages) intersected with the
opinion extensions it actually speaks: `ApprovalApi` (resolveApproval) and
`RecoveryIntrospection` (isRecovering/activeTurn/pendingChatTerminal). The
full `cf_agent_*` adapter requires all three; a bare turn driver requires
only `ConversationApi`. Interface definitions live in ADR-0002. This issue
does NOT wait for the ChatAgent extraction — transports name capabilities,
not layers.

## ISSUE-031 — AsyncIterable tool outputs leak as `{}` (no streaming, no last-value collapse)

**Status:** open · **Area:** domain/tools (registry/runTool) + turn loop · **Found by:** P7 ported hooks tests (4 tests)

A tool `execute` returning an AsyncIterable/AsyncGenerator should stream
preliminary tool-result chunks and settle the tool part with the LAST yielded
value as the final output (original Think semantics). The rebuild passes the
iterator object through untouched: it becomes the model-visible output and
JSON-serializes as `{}` — silent data loss for any streaming tool. Fix in the
tool runner: detect async iteration, drain (emitting preliminary chunks),
settle on the last value.

## ISSUE-032 — Output normalization throws on cyclic values instead of coercing (cyclic/BigInt/Symbol)

**Status:** open · **Area:** kernel/json (`normalizeJson`) + actions ledger · **Found by:** P7 ported hooks tests (2 tests)

Original coerces un-JSON-able tool/action outputs: circular refs →
`"[Circular]"`, BigInt → `"12n"`, Symbol → `{ type: "symbol" }` (and the
action ledger row is released, not wedged). The rebuild's `normalizeJson`
throws (`"normalizeJson: cyclic value"`), turning a legitimate return value
into a tool error. Decide per-type coercions and align; keep the ledger
release-on-normalize behavior.

## ISSUE-033 — afterToolCall/beforeToolCall observability contract diverges on gating paths

**Status:** open · **Area:** domain/tools (registry/runTool hooks) · **Found by:** P7 ported hooks tests (8 tests)

Three related divergences from the original hook contract, all in `runTool`:
(a) after an `allow`-with-substituted-input decision, `afterToolCall.input`
receives the SUBSTITUTED input — the original passes what the model actually
emitted, so audit trails now diverge from the transcript (real-bug flavored);
(b) on `block`/`substitute` decisions the wrapper returns early and
`afterToolCall` never fires — the original fired it with the block reason as
output (and block output is `{ blocked: true, reason }` vs the original's
bare reason string); (c) a THROWING `beforeToolCall` is invoked outside the
try/catch, so the throw propagates instead of converting to a tool-error with
`afterToolCall(success: false)`. Fix together — they're one contract.

## ISSUE-034 — deleteSubmissions() deletes pending/running rows when explicitly requested

**Status:** open · **Area:** domain/reliability/submissions · **Found by:** P8 ported submissions tests (1 test)

`deleteSubmissions` filters only on the caller-supplied `statuses` (default
`SETTLED_STATUSES`) and never enforces settled-only. Passing
`["pending","running","completed"]` deletes all three; the original refuses
active rows even when requested (returns 1, rebuild returns 3). Deleting a
`running` row orphans the in-flight run — `runOne`'s settlement re-read finds
no row and silently drops the outcome; a deleted `pending` row silently
vanishes from the FIFO. Fix: intersect the requested statuses with
settled-only (or explicitly skip active rows), matching the original.
